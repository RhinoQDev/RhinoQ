package integration

import (
	"context"
	"testing"
	"time"

	"github.com/rhinoq/rhinoq/internal/adapters/memory"
	"github.com/rhinoq/rhinoq/internal/application/operations"
	"github.com/rhinoq/rhinoq/internal/ports"
)

func TestQueueRateLimitIsGlobalAcrossClaims(t *testing.T) {
	now := time.Date(2026, 7, 27, 10, 0, 0, 0, time.UTC)
	store := memory.NewJobStoreWithClock(func() time.Time { return now })
	control, err := operations.NewQueueControl(store)
	if err != nil {
		t.Fatal(err)
	}
	if err := control.SetRateLimit(context.Background(), "media", 2, time.Minute); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 3; i++ {
		if _, err := store.Enqueue(context.Background(), ports.EnqueueInput{Name: "media", Payload: []byte("{}")}); err != nil {
			t.Fatal(err)
		}
	}

	first, err := store.Claim(context.Background(), ports.ClaimInput{
		Now: now, Limit: 10, LeaseDuration: time.Minute,
	})
	if err != nil || len(first) != 2 {
		t.Fatalf("first claim should consume global allowance: len=%d err=%v", len(first), err)
	}
	second, err := store.Claim(context.Background(), ports.ClaimInput{
		Now: now, Limit: 10, LeaseDuration: time.Minute,
	})
	if err != nil || len(second) != 0 {
		t.Fatalf("same window must remain limited: len=%d err=%v", len(second), err)
	}
	ttl, err := control.RateLimitTTL(context.Background(), "media", now.Add(15*time.Second))
	if err != nil || ttl != 45*time.Second {
		t.Fatalf("expected 45s rate-limit ttl, got %s err=%v", ttl, err)
	}

	afterReset, err := store.Claim(context.Background(), ports.ClaimInput{
		Now: now.Add(time.Minute), Limit: 10, LeaseDuration: time.Minute,
	})
	if err != nil || len(afterReset) != 1 {
		t.Fatalf("new window should release waiting work: len=%d err=%v", len(afterReset), err)
	}
}

func TestRemovingQueueRateLimitReleasesWaitingJobs(t *testing.T) {
	now := time.Now().UTC()
	store := memory.NewJobStoreWithClock(func() time.Time { return now })
	control, err := operations.NewQueueControl(store)
	if err != nil {
		t.Fatal(err)
	}
	if err := control.SetRateLimit(context.Background(), "sync", 1, time.Hour); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 2; i++ {
		if _, err := store.Enqueue(context.Background(), ports.EnqueueInput{Name: "sync", Payload: []byte("{}")}); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := store.Claim(context.Background(), ports.ClaimInput{Now: now, Limit: 1, LeaseDuration: time.Minute}); err != nil {
		t.Fatal(err)
	}
	if err := control.RemoveRateLimit(context.Background(), "sync"); err != nil {
		t.Fatal(err)
	}
	claimed, err := store.Claim(context.Background(), ports.ClaimInput{Now: now, Limit: 1, LeaseDuration: time.Minute})
	if err != nil || len(claimed) != 1 {
		t.Fatalf("removed limit should release waiting job: len=%d err=%v", len(claimed), err)
	}
}
