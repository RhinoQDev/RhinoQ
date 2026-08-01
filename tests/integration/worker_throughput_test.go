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

// One slow job must not hold up the rest of the batch. A worker that waits for
// a whole claim to finish before claiming again runs at the speed of its
// slowest job, which is the difference between a queue and a queue that works.
func TestSlowJobDoesNotBlockTheRestOfTheBatch(t *testing.T) {
	store := memory.NewJobStore()
	ctx := context.Background()
	blocking, err := store.Enqueue(ctx, ports.EnqueueInput{
		Identity: job.Identity{QueueName: "mixed", JobName: "mixed"},
		Payload:  []byte("{}"), Priority: 10,
	})
	if err != nil {
		t.Fatal(err)
	}
	for count := 0; count < 20; count++ {
		if _, err := store.Enqueue(ctx, ports.EnqueueInput{Identity: job.Identity{QueueName: "mixed", JobName: "mixed"}, Payload: []byte("{}")}); err != nil {
			t.Fatal(err)
		}
	}

	release := make(chan struct{})
	var fast atomic.Int64
	registry := worker.NewHandlerRegistry()
	if err := registry.Register("mixed", "mixed", func(_ context.Context, record job.Record) error {
		if record.ID == blocking {
			<-release
			return nil
		}
		fast.Add(1)
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	w, err := worker.New(worker.Config{
		Store: store, Handlers: registry, Owner: "worker-1",
		RetryPolicy: retry.Policy{MaxAttempts: 3, BaseDelay: time.Millisecond},
		Concurrency: 4, LeaseDuration: time.Minute, HeartbeatEvery: 10 * time.Second,
		PollInterval: time.Millisecond,
	})
	if err != nil {
		t.Fatal(err)
	}
	runCtx, stop := context.WithCancel(ctx)
	defer stop()
	go func() { _ = w.Run(runCtx) }()

	deadline := time.After(3 * time.Second)
	for fast.Load() < 20 {
		select {
		case <-deadline:
			close(release)
			t.Fatalf("only %d of 20 fast jobs ran while one job was slow", fast.Load())
		case <-time.After(time.Millisecond):
		}
	}
	close(release)

	// A handler returning and the worker durably recording success are separate
	// steps. Under -race the observation above can win that small window, so
	// wait for the store boundary instead of cancelling the worker immediately.
	recordDeadline := time.Now().Add(3 * time.Second)
	for {
		counts, countErr := store.JobCounts(ctx, "mixed")
		if countErr != nil {
			t.Fatal(countErr)
		}
		if counts[job.Succeeded] >= 20 {
			break
		}
		if time.Now().After(recordDeadline) {
			t.Fatalf("expected the fast jobs to be recorded as succeeded: %+v", counts)
		}
		time.Sleep(time.Millisecond)
	}
	stop()
}

// A rate-limited queue should not be polled in a tight loop, and it should not
// wait a full backoff either: the worker wakes when the window opens.
func TestWorkerRespectsQueueRateLimitWithoutSpinning(t *testing.T) {
	store := memory.NewJobStore()
	ctx := context.Background()
	if err := store.SetQueueRateLimit(ctx, "throttled", ports.QueueRateLimit{
		Max: 1, Window: 150 * time.Millisecond,
	}); err != nil {
		t.Fatal(err)
	}
	for count := 0; count < 2; count++ {
		if _, err := store.Enqueue(ctx, ports.EnqueueInput{Identity: job.Identity{QueueName: "throttled", JobName: "throttled"}, Payload: []byte("{}")}); err != nil {
			t.Fatal(err)
		}
	}
	var processed atomic.Int64
	registry := worker.NewHandlerRegistry()
	if err := registry.Register("throttled", "throttled", func(context.Context, job.Record) error {
		processed.Add(1)
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	w, err := worker.New(worker.Config{
		Store: store, Handlers: registry, Owner: "worker-1",
		RetryPolicy: retry.Policy{MaxAttempts: 3, BaseDelay: time.Millisecond},
		Concurrency: 4, LeaseDuration: time.Minute, HeartbeatEvery: 10 * time.Second,
		PollInterval: time.Millisecond, MaxPollInterval: 5 * time.Second,
	})
	if err != nil {
		t.Fatal(err)
	}
	runCtx, stop := context.WithCancel(ctx)
	defer stop()
	go func() { _ = w.Run(runCtx) }()

	time.Sleep(50 * time.Millisecond)
	if got := processed.Load(); got != 1 {
		t.Fatalf("the rate limit should let exactly one job through in the first window, got %d", got)
	}
	deadline := time.After(2 * time.Second)
	for processed.Load() < 2 {
		select {
		case <-deadline:
			t.Fatal("the worker did not wake up when the rate limit window reopened")
		case <-time.After(5 * time.Millisecond):
		}
	}
}
