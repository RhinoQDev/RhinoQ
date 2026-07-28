package integration

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/madebyduy/RhinoQ/internal/adapters/memory"
	"github.com/madebyduy/RhinoQ/internal/application/execution"
	"github.com/madebyduy/RhinoQ/internal/ports"
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
	claimed, err := claimJobs.Execute(ctx, "worker-1", now, 1, time.Minute)
	if err != nil || len(claimed) != 1 {
		t.Fatalf("expected one claimed job, got %d, err=%v", len(claimed), err)
	}
	if claimed[0].ID != id || claimed[0].LeaseOwner != "worker-1" || claimed[0].LeaseEpoch != 1 {
		t.Fatalf("claim did not return authoritative lease: %+v", claimed[0])
	}

	lease := ports.LeaseFor(claimed[0])
	status, err := store.RenewLease(ctx, lease, now.Add(30*time.Second), time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	if status.CancelRequested || !status.ExpiresAt.After(now.Add(30*time.Second)) {
		t.Fatalf("renewal should extend the lease and report no cancellation: %+v", status)
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
	claimed, err := store.Claim(ctx, ports.ClaimInput{Owner: "worker-1", Now: now, Limit: 1, LeaseDuration: time.Minute})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.RenewLease(ctx, ports.LeaseFor(claimed[0]), now.Add(2*time.Minute), time.Minute); !errors.Is(err, ports.ErrLeaseLost) {
		t.Fatalf("expected expired lease renewal to be fenced, got %v", err)
	}
}

func TestExpiredLeaseCannotComplete(t *testing.T) {
	now := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	store := memory.NewJobStoreWithClock(func() time.Time { return now })
	ctx := context.Background()
	if _, err := store.Enqueue(ctx, ports.EnqueueInput{Name: "slow-job", Payload: []byte("{}")}); err != nil {
		t.Fatal(err)
	}
	claimed, err := store.Claim(ctx, ports.ClaimInput{Owner: "worker-1", Now: now, Limit: 1, LeaseDuration: time.Minute})
	if err != nil {
		t.Fatal(err)
	}
	if err := store.Complete(ctx, ports.LeaseFor(claimed[0]), now.Add(2*time.Minute)); !errors.Is(err, ports.ErrLeaseLost) {
		t.Fatalf("expected expired lease completion to be fenced, got %v", err)
	}
}

// A worker that stalls, loses its lease and comes back must not be able to write
// anything: the epoch moved on even though the owner name repeats.
func TestStaleEpochCannotWriteAfterRequeue(t *testing.T) {
	now := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	clock := now
	store := memory.NewJobStoreWithClock(func() time.Time { return clock })
	ctx := context.Background()
	if _, err := store.Enqueue(ctx, ports.EnqueueInput{Name: "charge-card", Payload: []byte("{}")}); err != nil {
		t.Fatal(err)
	}
	first, err := store.Claim(ctx, ports.ClaimInput{Owner: "worker-1", Now: now, Limit: 1, LeaseDuration: time.Minute})
	if err != nil || len(first) != 1 {
		t.Fatalf("first claim: len=%d err=%v", len(first), err)
	}
	stale := ports.LeaseFor(first[0])

	expired := now.Add(2 * time.Minute)
	if _, err := store.RequeueExpired(ctx, ports.ReapInput{Now: expired}); err != nil {
		t.Fatal(err)
	}
	// The same worker name claims the job again; only the epoch tells the two
	// executions apart.
	second, err := store.Claim(ctx, ports.ClaimInput{Owner: "worker-1", Now: expired, Limit: 1, LeaseDuration: time.Minute})
	if err != nil || len(second) != 1 {
		t.Fatalf("second claim: len=%d err=%v", len(second), err)
	}
	if second[0].LeaseEpoch != stale.Epoch+1 {
		t.Fatalf("claim must advance the fencing epoch: %d -> %d", stale.Epoch, second[0].LeaseEpoch)
	}

	later := expired.Add(time.Second)
	writes := map[string]func() error{
		"complete": func() error { return store.Complete(ctx, stale, later) },
		"fail": func() error {
			return store.Fail(ctx, stale, later, ports.FailureTransition{State: "dead"})
		},
		"renew": func() error {
			_, err := store.RenewLease(ctx, stale, later, time.Minute)
			return err
		},
		"release": func() error { return store.ReleaseLease(ctx, stale, later) },
		"check":   func() error { return store.CheckLease(ctx, stale, later) },
	}
	for name, write := range writes {
		if err := write(); !errors.Is(err, ports.ErrLeaseLost) {
			t.Fatalf("%s from a stale epoch must be fenced, got %v", name, err)
		}
	}

	record, ok, err := store.Get(ctx, first[0].ID)
	if err != nil || !ok || record.State.String() != "leased" {
		t.Fatalf("the live execution must keep the job: ok=%v err=%v record=%+v", ok, err, record)
	}
}

// Releasing a prefetched job returns the attempt as well: it never ran.
func TestReleaseLeaseGivesBackTheAttempt(t *testing.T) {
	now := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	store := memory.NewJobStoreWithClock(func() time.Time { return now })
	ctx := context.Background()
	id, err := store.Enqueue(ctx, ports.EnqueueInput{Name: "prefetched", Payload: []byte("{}")})
	if err != nil {
		t.Fatal(err)
	}
	claimed, err := store.Claim(ctx, ports.ClaimInput{Owner: "worker-1", Now: now, Limit: 1, LeaseDuration: time.Minute})
	if err != nil || len(claimed) != 1 || claimed[0].Attempts != 1 {
		t.Fatalf("claim fixture: %+v err=%v", claimed, err)
	}
	if err := store.ReleaseLease(ctx, ports.LeaseFor(claimed[0]), now.Add(time.Second)); err != nil {
		t.Fatal(err)
	}
	record, ok, err := store.Get(ctx, id)
	if err != nil || !ok || record.Attempts != 0 || record.State.String() != "retry_wait" {
		t.Fatalf("released job should be claimable again with its attempt back: ok=%v err=%v record=%+v", ok, err, record)
	}
}
