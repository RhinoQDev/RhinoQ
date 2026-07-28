package integration

import (
	"context"
	"testing"
	"time"

	"github.com/rhinoq/rhinoq/internal/adapters/memory"
	"github.com/rhinoq/rhinoq/internal/domain/job"
	"github.com/rhinoq/rhinoq/internal/domain/retry"
	"github.com/rhinoq/rhinoq/internal/ports"
	"github.com/rhinoq/rhinoq/internal/runtime/worker"
)

func TestWorkerCompletesClaimedJob(t *testing.T) {
	now := time.Now().UTC()
	store := memory.NewJobStoreWithClock(func() time.Time { return now })
	ctx := context.Background()
	id, err := store.Enqueue(ctx, ports.EnqueueInput{Name: "send-email", Payload: []byte("{}")})
	if err != nil {
		t.Fatal(err)
	}
	registry := worker.NewHandlerRegistry()
	runCtx, cancel := context.WithCancel(context.Background())
	defer cancel()
	if err := registry.Register("send-email", func(context.Context, job.Record) error { cancel(); return nil }); err != nil {
		t.Fatal(err)
	}
	w, err := worker.New(worker.Config{Store: store, Handlers: registry, Owner: "worker-1", RetryPolicy: retry.Policy{MaxAttempts: 3, BaseDelay: time.Second}, MaxClaimBatch: 1, LeaseDuration: time.Minute, PollInterval: time.Millisecond, HeartbeatEvery: 10 * time.Millisecond, Concurrency: 1, Now: func() time.Time { return now }})
	if err != nil {
		t.Fatal(err)
	}
	if err := w.Run(runCtx); err != context.Canceled {
		t.Fatal("expected worker run to stop only with cancellation")
	}
	record, ok, err := store.Get(context.Background(), id)
	if err != nil || !ok || record.State != job.Succeeded {
		t.Fatalf("expected completed job, ok=%v err=%v record=%+v", ok, err, record)
	}
}

func TestWorkerClaimsOnlyQueuesWithRegisteredHandlers(t *testing.T) {
	now := time.Now().UTC()
	store := memory.NewJobStoreWithClock(func() time.Time { return now })
	ctx := context.Background()
	unhandledID, err := store.Enqueue(ctx, ports.EnqueueInput{
		Name: "resize-image", Payload: []byte("{}"),
	})
	if err != nil {
		t.Fatal(err)
	}
	handledID, err := store.Enqueue(ctx, ports.EnqueueInput{
		Name: "send-email", Payload: []byte("{}"),
	})
	if err != nil {
		t.Fatal(err)
	}

	registry := worker.NewHandlerRegistry()
	runCtx, cancel := context.WithCancel(context.Background())
	defer cancel()
	if err := registry.Register("send-email", func(context.Context, job.Record) error {
		cancel()
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	w, err := worker.New(worker.Config{
		Store: store, Handlers: registry, Owner: "email-worker",
		RetryPolicy:   retry.Policy{MaxAttempts: 3, BaseDelay: time.Second},
		MaxClaimBatch: 1, LeaseDuration: time.Minute, PollInterval: time.Millisecond,
		HeartbeatEvery: 10 * time.Millisecond, Concurrency: 1,
		Now: func() time.Time { return now },
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := w.Run(runCtx); err != context.Canceled {
		t.Fatalf("worker stopped unexpectedly: %v", err)
	}
	handled, _, err := store.Get(ctx, handledID)
	if err != nil || handled.State != job.Succeeded {
		t.Fatalf("registered queue should complete: %+v err=%v", handled, err)
	}
	unhandled, _, err := store.Get(ctx, unhandledID)
	if err != nil || unhandled.State != job.Pending || unhandled.Attempts != 0 {
		t.Fatalf("unregistered queue must remain untouched: %+v err=%v", unhandled, err)
	}
}
