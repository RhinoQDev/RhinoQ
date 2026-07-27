package integration

import (
	"context"
	"testing"
	"time"

	"github.com/rhinoq/rhinoq/internal/adapters/memory"
	"github.com/rhinoq/rhinoq/internal/ports"
	"github.com/rhinoq/rhinoq/internal/runtime/lease"
)

func TestReaperRequeuesExpiredLease(t *testing.T) {
	now := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	store := memory.NewJobStoreWithClock(func() time.Time { return now })
	ctx := context.Background()
	if _, err := store.Enqueue(ctx, ports.EnqueueInput{Name: "reap-me", Payload: []byte("{}")}); err != nil {
		t.Fatal(err)
	}
	claimed, err := store.Claim(ctx, ports.ClaimInput{Now: now, Limit: 1, LeaseDuration: time.Minute})
	if err != nil {
		t.Fatal(err)
	}
	if claimed[0].State.String() != "leased" {
		t.Fatalf("expected leased, got %s", claimed[0].State)
	}

	reaper, err := lease.NewReaper(store, time.Hour, func() time.Time { return now.Add(2 * time.Minute) })
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.RequeueExpired(ctx, now.Add(2*time.Minute)); err != nil {
		t.Fatal(err)
	}
	record, ok, err := store.Get(ctx, claimed[0].ID)
	if err != nil || !ok || record.State.String() != "retry_wait" {
		t.Fatalf("expected requeued job, ok=%v err=%v record=%+v", ok, err, record)
	}
	_ = reaper
}
