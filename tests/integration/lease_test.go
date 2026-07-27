package integration

import (
	"context"
	"testing"
	"time"

	"github.com/rhinoq/rhinoq/internal/adapters/memory"
	"github.com/rhinoq/rhinoq/internal/application/execution"
	"github.com/rhinoq/rhinoq/internal/ports"
)

func TestClaimLeaseRenewAndComplete(t *testing.T) {
	now := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	store := memory.NewJobStoreWithClock(func() time.Time { return now })
	ctx := context.Background()

	id, err := store.Enqueue(ctx, ports.EnqueueInput{Name: "generate-report", Payload: []byte("{}")})
	if err != nil {
		t.Fatal(err)
	}

	claimJobs := execution.NewClaimJobs(store)
	claimed, err := claimJobs.Execute(ctx, now, 1, time.Minute)
	if err != nil || len(claimed) != 1 {
		t.Fatalf("expected one claimed job, got %d, err=%v", len(claimed), err)
	}
	if claimed[0].ID != id || claimed[0].LeaseID == "" {
		t.Fatalf("claim did not return authoritative lease: %+v", claimed[0])
	}

	lease := ports.Lease{JobID: id, LeaseID: claimed[0].LeaseID}
	if err := store.RenewLease(ctx, lease, now.Add(30*time.Second), time.Minute); err != nil {
		t.Fatal(err)
	}
	if err := store.Complete(ctx, lease, now.Add(45*time.Second)); err != nil {
		t.Fatal(err)
	}

	record, ok, err := store.Get(ctx, id)
	if err != nil || !ok {
		t.Fatalf("expected completed job, ok=%v err=%v", ok, err)
	}
	if record.State.String() != "succeeded" {
		t.Fatalf("expected succeeded state, got %s", record.State)
	}
}

func TestExpiredLeaseCannotBeRenewed(t *testing.T) {
	now := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	store := memory.NewJobStoreWithClock(func() time.Time { return now })
	ctx := context.Background()
	if _, err := store.Enqueue(ctx, ports.EnqueueInput{Name: "sync-data", Payload: []byte("{}")}); err != nil {
		t.Fatal(err)
	}
	claimed, err := store.Claim(ctx, ports.ClaimInput{Now: now, Limit: 1, LeaseDuration: time.Minute})
	if err != nil {
		t.Fatal(err)
	}
	lease := ports.Lease{JobID: ports.JobID(claimed[0].ID), LeaseID: claimed[0].LeaseID}
	if err := store.RenewLease(ctx, lease, now.Add(2*time.Minute), time.Minute); err == nil {
		t.Fatal("expected expired lease renewal to fail")
	}
}

func TestExpiredLeaseCannotComplete(t *testing.T) {
	now := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	store := memory.NewJobStoreWithClock(func() time.Time { return now })
	ctx := context.Background()
	if _, err := store.Enqueue(ctx, ports.EnqueueInput{Name: "slow-job", Payload: []byte("{}")}); err != nil {
		t.Fatal(err)
	}
	claimed, err := store.Claim(ctx, ports.ClaimInput{Now: now, Limit: 1, LeaseDuration: time.Minute})
	if err != nil {
		t.Fatal(err)
	}
	lease := ports.Lease{JobID: ports.JobID(claimed[0].ID), LeaseID: claimed[0].LeaseID}
	if err := store.Complete(ctx, lease, now.Add(2*time.Minute)); err == nil {
		t.Fatal("expected expired lease completion to fail")
	}
}
