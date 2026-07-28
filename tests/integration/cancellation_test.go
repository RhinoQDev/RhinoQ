package integration

import (
	"context"
	"testing"
	"time"

	"github.com/madebyduy/RhinoQ/internal/adapters/memory"
	"github.com/madebyduy/RhinoQ/internal/application/operations"
	"github.com/madebyduy/RhinoQ/internal/domain/job"
	"github.com/madebyduy/RhinoQ/internal/domain/retry"
	"github.com/madebyduy/RhinoQ/internal/ports"
	"github.com/madebyduy/RhinoQ/internal/runtime/worker"
)

func TestCancelPendingJobCannotBeClaimed(t *testing.T) {
	now := time.Now().UTC()
	store := memory.NewJobStoreWithClock(func() time.Time { return now })
	id, err := store.Enqueue(context.Background(), ports.EnqueueInput{Identity: job.Identity{QueueName: "report", JobName: "report"}, Payload: []byte("{}")})
	if err != nil {
		t.Fatal(err)
	}
	cancel, err := operations.NewJobCancellation(store)
	if err != nil {
		t.Fatal(err)
	}
	if err := cancel.Cancel(context.Background(), id); err != nil {
		t.Fatal(err)
	}
	claimed, err := store.Claim(context.Background(), ports.ClaimInput{Owner: "worker-1", Now: now, Limit: 1, LeaseDuration: time.Minute})
	if err != nil || len(claimed) != 0 {
		t.Fatalf("cancelled job must not be claimed: len=%d err=%v", len(claimed), err)
	}
	record, ok, err := store.Get(context.Background(), id)
	if err != nil || !ok || record.State != job.Cancelled {
		t.Fatalf("expected cancelled record: ok=%v err=%v record=%+v", ok, err, record)
	}
}

func TestWorkerCooperativelyCancelsLeasedJob(t *testing.T) {
	store := memory.NewJobStore()
	id, err := store.Enqueue(context.Background(), ports.EnqueueInput{Identity: job.Identity{QueueName: "long-job", JobName: "long-job"}, Payload: []byte("{}")})
	if err != nil {
		t.Fatal(err)
	}
	started := make(chan struct{})
	registry := worker.NewHandlerRegistry()
	if err := registry.Register("long-job", "long-job", func(ctx context.Context, _ job.Record) error {
		close(started)
		<-ctx.Done()
		return ctx.Err()
	}); err != nil {
		t.Fatal(err)
	}
	w, err := worker.New(worker.Config{
		Store: store, Handlers: registry, Owner: "worker-1",
		RetryPolicy:   retry.Policy{MaxAttempts: 3, BaseDelay: time.Millisecond},
		MaxClaimBatch: 1, LeaseDuration: 100 * time.Millisecond, PollInterval: time.Millisecond,
		HeartbeatEvery: 5 * time.Millisecond, Concurrency: 1,
	})
	if err != nil {
		t.Fatal(err)
	}
	runCtx, stop := context.WithCancel(context.Background())
	defer stop()
	done := make(chan error, 1)
	go func() { done <- w.Run(runCtx) }()
	select {
	case <-started:
	case <-time.After(time.Second):
		t.Fatal("handler did not start")
	}
	if err := store.RequestCancel(context.Background(), id); err != nil {
		t.Fatal(err)
	}
	deadline := time.After(time.Second)
	for {
		record, ok, err := store.Get(context.Background(), id)
		if err != nil || !ok {
			t.Fatalf("get cancelled job: ok=%v err=%v", ok, err)
		}
		if record.State == job.Cancelled {
			break
		}
		select {
		case <-deadline:
			t.Fatalf("job was not cancelled: %+v", record)
		case <-time.After(time.Millisecond):
		}
	}
	stop()
	if err := <-done; err != context.Canceled {
		t.Fatalf("expected worker cancellation, got %v", err)
	}
}
