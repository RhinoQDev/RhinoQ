package fault

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/madebyduy/RhinoQ/internal/adapters/memory"
	"github.com/madebyduy/RhinoQ/internal/domain/job"
	"github.com/madebyduy/RhinoQ/internal/ports"
)

// The producer's transaction commits and the connection dies before the ID
// comes back. The producer cannot tell "not enqueued" from "enqueued and I did
// not hear about it", so it retries — which is the correct thing to do and also
// the moment a queue without idempotency runs the job twice.
func TestALostEnqueueAcknowledgementDoesNotDuplicateTheJob(t *testing.T) {
	now := time.Date(2026, 8, 3, 9, 0, 0, 0, time.UTC)
	base := memory.NewJobStoreWithClock(func() time.Time { return now })
	store := &faultyJobStore{
		JobStore: base,
		injector: newInjector(faultPlan{operation: "Enqueue", onCall: 1, afterApply: true}),
	}
	ctx := context.Background()
	input := ports.EnqueueInput{
		Identity:       job.Identity{QueueName: "charge-card", JobName: "charge-card"},
		Payload:        []byte(`{"invoice":"inv_1"}`),
		IdempotencyKey: "invoice:inv_1",
	}

	if _, err := store.Enqueue(ctx, input); !errors.Is(err, errConnectionReset) {
		t.Fatalf("the injected fault must surface to the producer, got %v", err)
	}

	// The producer retries with the same key, exactly as an at-least-once
	// producer must.
	id, err := store.Enqueue(ctx, input)
	if err != nil {
		t.Fatalf("the retry must succeed once the connection is back: %v", err)
	}

	records, err := base.ListJobs(ctx, ports.ListJobsInput{QueueName: "charge-card", Limit: 10})
	if err != nil {
		t.Fatal(err)
	}
	if len(records) != 1 {
		t.Fatalf("a lost acknowledgement must not create a second job, got %d: %+v", len(records), records)
	}
	if records[0].ID != id {
		t.Fatalf("the retry must return the durable job that already existed: got %s, stored %s", id, records[0].ID)
	}
}

// Without an idempotency key there is nothing to deduplicate on. This is not a
// defect to fix in the store — it is a property adopters must know, so it is
// pinned rather than left implied.
func TestALostEnqueueAcknowledgementDuplicatesWithoutAnIdempotencyKey(t *testing.T) {
	now := time.Date(2026, 8, 3, 9, 0, 0, 0, time.UTC)
	base := memory.NewJobStoreWithClock(func() time.Time { return now })
	store := &faultyJobStore{
		JobStore: base,
		injector: newInjector(faultPlan{operation: "Enqueue", onCall: 1, afterApply: true}),
	}
	ctx := context.Background()
	input := ports.EnqueueInput{
		Identity: job.Identity{QueueName: "send-email", JobName: "send-email"},
		Payload:  []byte(`{"to":"a@example.com"}`),
	}

	if _, err := store.Enqueue(ctx, input); !errors.Is(err, errConnectionReset) {
		t.Fatalf("expected the injected fault, got %v", err)
	}
	if _, err := store.Enqueue(ctx, input); err != nil {
		t.Fatal(err)
	}

	records, err := base.ListJobs(ctx, ports.ListJobsInput{QueueName: "send-email", Limit: 10})
	if err != nil {
		t.Fatal(err)
	}
	if len(records) != 2 {
		t.Fatalf(
			"expected the documented duplicate without an idempotency key, got %d. "+
				"If deduplication became implicit, say so in the docs instead of deleting this test.",
			len(records),
		)
	}
}

// The handler finished and the completion committed, then the connection died.
// A worker that retries Complete must not be told the job is gone or resurrect
// it: the second call has to be a no-op against the same epoch.
func TestARetriedCompletionAfterALostAcknowledgementIsANoOp(t *testing.T) {
	now := time.Date(2026, 8, 3, 9, 0, 0, 0, time.UTC)
	base := memory.NewJobStoreWithClock(func() time.Time { return now })
	store := &faultyJobStore{
		JobStore: base,
		injector: newInjector(faultPlan{operation: "Complete", onCall: 1, afterApply: true}),
	}
	ctx := context.Background()
	id, err := base.Enqueue(ctx, ports.EnqueueInput{
		Identity: job.Identity{QueueName: "generate-report", JobName: "generate-report"},
		Payload:  []byte("{}"),
	})
	if err != nil {
		t.Fatal(err)
	}
	lease := mustClaim(t, store, "worker-1", now, time.Minute)

	if err := store.Complete(ctx, lease, now.Add(time.Second)); !errors.Is(err, errConnectionReset) {
		t.Fatalf("expected the injected fault, got %v", err)
	}

	record, ok, err := base.Get(ctx, id)
	if err != nil || !ok {
		t.Fatalf("job lookup: ok=%v err=%v", ok, err)
	}
	if record.State.String() != "succeeded" {
		t.Fatalf("the completion committed before the fault; state is %s", record.State)
	}

	// The worker retries. Whatever this returns, it must not leave the job in
	// any state other than succeeded, and must not re-open it for another
	// worker.
	retryErr := store.Complete(ctx, lease, now.Add(2*time.Second))
	after, ok, err := base.Get(ctx, id)
	if err != nil || !ok {
		t.Fatalf("job lookup after retry: ok=%v err=%v", ok, err)
	}
	if after.State.String() != "succeeded" {
		t.Fatalf("a retried completion must not move a finished job, got %s (retry err=%v)", after.State, retryErr)
	}

	claimed, err := base.Claim(ctx, ports.ClaimInput{
		Owner: "worker-2", Now: now.Add(time.Hour), Limit: 1, LeaseDuration: time.Minute,
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(claimed) != 0 {
		t.Fatalf("a completed job must not become claimable again, got %+v", claimed)
	}
}
