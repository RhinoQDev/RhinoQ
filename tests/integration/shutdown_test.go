package integration

import (
	"context"
	"sync/atomic"
	"testing"
	"time"

	"github.com/madebyduy/RhinoQ/internal/adapters/memory"
	"github.com/madebyduy/RhinoQ/internal/domain/job"
	"github.com/madebyduy/RhinoQ/internal/domain/retry"
	"github.com/madebyduy/RhinoQ/internal/ports"
	"github.com/madebyduy/RhinoQ/internal/runtime/worker"
)

// A deploy must not turn running work into orphaned jobs: the worker stops
// claiming, lets the handler finish, and only then returns.
func TestShutdownLetsRunningHandlersFinish(t *testing.T) {
	store := memory.NewJobStore()
	ctx := context.Background()
	id, err := store.Enqueue(ctx, ports.EnqueueInput{Name: "slow", Payload: []byte("{}")})
	if err != nil {
		t.Fatal(err)
	}
	started := make(chan struct{})
	registry := worker.NewHandlerRegistry()
	if err := registry.Register("slow", func(ctx context.Context, _ job.Record) error {
		close(started)
		select {
		case <-time.After(150 * time.Millisecond):
			return nil
		case <-ctx.Done():
			return ctx.Err()
		}
	}); err != nil {
		t.Fatal(err)
	}
	w := newTestWorker(t, store, registry)

	runCtx, stop := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- w.Run(runCtx) }()
	<-started
	stop()

	select {
	case err := <-done:
		if err != context.Canceled {
			t.Fatalf("expected the run context error, got %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("worker did not shut down")
	}
	record, ok, err := store.Get(ctx, id)
	if err != nil || !ok || record.State != job.Succeeded {
		t.Fatalf("a graceful shutdown must let the job complete: ok=%v err=%v record=%+v", ok, err, record)
	}
}

// A handler that ignores cancellation is not killed: its lease is left to
// expire, because releasing it early is what creates two live executions.
func TestShutdownCancelsThenAbandonsUnresponsiveHandlers(t *testing.T) {
	store := memory.NewJobStore()
	ctx := context.Background()
	id, err := store.Enqueue(ctx, ports.EnqueueInput{Name: "stubborn", Payload: []byte("{}")})
	if err != nil {
		t.Fatal(err)
	}
	started := make(chan struct{})
	release := make(chan struct{})
	var cancelled atomic.Bool
	registry := worker.NewHandlerRegistry()
	if err := registry.Register("stubborn", func(ctx context.Context, _ job.Record) error {
		close(started)
		go func() {
			<-ctx.Done()
			cancelled.Store(true)
		}()
		<-release
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	w, err := worker.New(worker.Config{
		Store: store, Handlers: registry, Owner: "worker-1",
		RetryPolicy: retry.Policy{MaxAttempts: 3, BaseDelay: time.Millisecond},
		Concurrency: 1, LeaseDuration: time.Minute, HeartbeatEvery: 10 * time.Second,
		PollInterval: time.Millisecond, ShutdownGrace: 20 * time.Millisecond,
		CancelGrace: 20 * time.Millisecond,
	})
	if err != nil {
		t.Fatal(err)
	}
	go func() { _ = w.Run(ctx) }()
	<-started

	report := w.Shutdown(ctx)
	if report.Cancelled != 1 || report.Abandoned != 1 {
		t.Fatalf("an unresponsive handler must be cancelled and then abandoned: %+v", report)
	}
	if !cancelled.Load() {
		t.Fatal("the handler should have received a cancellation signal")
	}
	record, ok, err := store.Get(ctx, id)
	if err != nil || !ok || record.State != job.Leased {
		t.Fatalf("the lease must be left alone while the handler may still run: ok=%v err=%v record=%+v", ok, err, record)
	}
	close(release)
}

// Work that was prefetched but never started is handed back, attempt included.
func TestStoppedWorkerReleasesPrefetchedJobs(t *testing.T) {
	store := memory.NewJobStore()
	ctx := context.Background()
	for count := 0; count < 3; count++ {
		if _, err := store.Enqueue(ctx, ports.EnqueueInput{Name: "prefetch", Payload: []byte("{}")}); err != nil {
			t.Fatal(err)
		}
	}
	started := make(chan struct{}, 1)
	release := make(chan struct{})
	registry := worker.NewHandlerRegistry()
	if err := registry.Register("prefetch", func(context.Context, job.Record) error {
		select {
		case started <- struct{}{}:
		default:
		}
		<-release
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	w, err := worker.New(worker.Config{
		Store: store, Handlers: registry, Owner: "worker-1",
		RetryPolicy: retry.Policy{MaxAttempts: 3, BaseDelay: time.Millisecond},
		Concurrency: 1, PrefetchFactor: 3, MaxClaimBatch: 3,
		LeaseDuration: time.Minute, HeartbeatEvery: 10 * time.Second,
		PollInterval: time.Millisecond,
	})
	if err != nil {
		t.Fatal(err)
	}
	go func() { _ = w.Run(ctx) }()
	<-started

	w.StopClaiming()
	close(release)
	deadline := time.After(2 * time.Second)
	for {
		counts, err := store.JobCounts(ctx, "prefetch")
		if err != nil {
			t.Fatal(err)
		}
		if counts[job.RetryWait] == 2 && counts[job.Succeeded] == 1 {
			break
		}
		select {
		case <-deadline:
			t.Fatalf("prefetched work was not handed back: %+v", counts)
		case <-time.After(time.Millisecond):
		}
	}
	waiting, err := store.ListJobs(ctx, ports.ListJobsInput{
		Name: "prefetch", States: []job.State{job.RetryWait}, Limit: 10,
	})
	if err != nil {
		t.Fatal(err)
	}
	for _, record := range waiting {
		if record.Attempts != 0 {
			t.Fatalf("a job that never ran must keep its full attempt budget: %+v", record)
		}
	}
}

func newTestWorker(t *testing.T, store ports.JobStore, registry *worker.HandlerRegistry) *worker.Worker {
	t.Helper()
	w, err := worker.New(worker.Config{
		Store: store, Handlers: registry, Owner: "worker-1",
		RetryPolicy: retry.Policy{MaxAttempts: 3, BaseDelay: time.Millisecond},
		Concurrency: 2, LeaseDuration: time.Minute, HeartbeatEvery: 10 * time.Second,
		PollInterval: time.Millisecond, ShutdownGrace: time.Second, CancelGrace: 100 * time.Millisecond,
	})
	if err != nil {
		t.Fatal(err)
	}
	return w
}
