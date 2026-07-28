package integration

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/madebyduy/RhinoQ/internal/adapters/memory"
	"github.com/madebyduy/RhinoQ/internal/application/enqueue"
	"github.com/madebyduy/RhinoQ/internal/application/operations"
	"github.com/madebyduy/RhinoQ/internal/domain/admission"
	"github.com/madebyduy/RhinoQ/internal/domain/job"
	"github.com/madebyduy/RhinoQ/internal/ports"
)

func TestAdmissionRejectsOverflowAndKeepsCriticalRoom(t *testing.T) {
	now := time.Date(2026, 7, 27, 11, 0, 0, 0, time.UTC)
	store := memory.NewJobStoreWithClock(func() time.Time { return now })
	control, err := operations.NewQueueControl(store)
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	if err := control.SetAdmission(ctx, "reports", admission.Policy{
		MaxPending: 3, ReservedCritical: 1, OnOverflow: admission.Reject,
	}); err != nil {
		t.Fatal(err)
	}

	service := enqueue.NewService(store)
	for accepted := 0; accepted < 2; accepted++ {
		if _, err := service.Execute(ctx, ports.EnqueueInput{Identity: job.Identity{QueueName: "reports", JobName: "reports"}, Payload: []byte("{}")}); err != nil {
			t.Fatalf("enqueue %d below the shared budget: %v", accepted, err)
		}
	}
	_, err = service.Execute(ctx, ports.EnqueueInput{Identity: job.Identity{QueueName: "reports", JobName: "reports"}, Payload: []byte("{}")})
	if !errors.Is(err, admission.ErrOverCapacity) {
		t.Fatalf("standard work must be rejected at the reserved line, got %v", err)
	}
	// The reserve is exactly what keeps a flooded report queue from blocking a
	// payment.
	if _, err := service.Execute(ctx, ports.EnqueueInput{
		Identity: job.Identity{QueueName: "reports", JobName: "reports", ResourceClass: job.Critical},
		Payload:  []byte("{}"),
	}); err != nil {
		t.Fatalf("critical work must still be admitted: %v", err)
	}

	counts, err := store.JobCounts(ctx, "reports")
	if err != nil || counts[job.Pending] != 3 {
		t.Fatalf("unexpected queue depth: %+v err=%v", counts, err)
	}
}

func TestAdmissionDelayModePushesRunTimeInsteadOfRejecting(t *testing.T) {
	now := time.Date(2026, 7, 27, 11, 0, 0, 0, time.UTC)
	store := memory.NewJobStoreWithClock(func() time.Time { return now })
	control, err := operations.NewQueueControl(store)
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	if err := control.SetAdmission(ctx, "telemetry", admission.Policy{
		MaxPending: 1, OnOverflow: admission.Delay, DelayBy: time.Minute,
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := store.Enqueue(ctx, ports.EnqueueInput{Identity: job.Identity{QueueName: "telemetry", JobName: "telemetry"}, Payload: []byte("{}")}); err != nil {
		t.Fatal(err)
	}
	delayed, err := store.Enqueue(ctx, ports.EnqueueInput{Identity: job.Identity{QueueName: "telemetry", JobName: "telemetry"}, Payload: []byte("{}")})
	if err != nil {
		t.Fatalf("delay mode must accept the job: %v", err)
	}
	record, ok, err := store.Get(ctx, delayed)
	if err != nil || !ok || !record.NotBefore.Equal(now.Add(time.Minute)) {
		t.Fatalf("overflow should defer the job by a minute: ok=%v err=%v record=%+v", ok, err, record)
	}
	claimed, err := store.Claim(ctx, ports.ClaimInput{
		Owner: "worker-1", Now: now, Limit: 10, LeaseDuration: time.Minute,
	})
	if err != nil || len(claimed) != 1 {
		t.Fatalf("only the non-deferred job is claimable now: len=%d err=%v", len(claimed), err)
	}
}

func TestRemovingAdmissionRestoresUnboundedEnqueue(t *testing.T) {
	now := time.Date(2026, 7, 27, 11, 0, 0, 0, time.UTC)
	store := memory.NewJobStoreWithClock(func() time.Time { return now })
	control, err := operations.NewQueueControl(store)
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	if err := control.SetAdmission(ctx, "bulk", admission.Policy{MaxPending: 1, OnOverflow: admission.Reject}); err != nil {
		t.Fatal(err)
	}
	if _, err := store.Enqueue(ctx, ports.EnqueueInput{Identity: job.Identity{QueueName: "bulk", JobName: "bulk"}, Payload: []byte("{}")}); err != nil {
		t.Fatal(err)
	}
	if _, err := store.Enqueue(ctx, ports.EnqueueInput{Identity: job.Identity{QueueName: "bulk", JobName: "bulk"}, Payload: []byte("{}")}); !errors.Is(err, admission.ErrOverCapacity) {
		t.Fatalf("expected the budget to bite, got %v", err)
	}
	if err := control.RemoveAdmission(ctx, "bulk"); err != nil {
		t.Fatal(err)
	}
	if _, err := store.Enqueue(ctx, ports.EnqueueInput{Identity: job.Identity{QueueName: "bulk", JobName: "bulk"}, Payload: []byte("{}")}); err != nil {
		t.Fatalf("removing the budget must restore enqueue: %v", err)
	}
}
