package integration

import (
	"context"
	"testing"
	"time"

	"github.com/madebyduy/RhinoQ/internal/adapters/memory"
	"github.com/madebyduy/RhinoQ/internal/domain/job"
	"github.com/madebyduy/RhinoQ/internal/ports"
)

func TestClaimOrdersByPriorityThenFirstIn(t *testing.T) {
	now := time.Date(2026, 7, 27, 9, 0, 0, 0, time.UTC)
	clock := now
	store := memory.NewJobStoreWithClock(func() time.Time { return clock })
	ctx := context.Background()

	enqueue := func(name string, priority int) job.ID {
		id, err := store.Enqueue(ctx, ports.EnqueueInput{Name: name, Payload: []byte("{}"), Priority: priority})
		if err != nil {
			t.Fatal(err)
		}
		clock = clock.Add(time.Second)
		return id
	}
	firstNormal := enqueue("mixed", 0)
	secondNormal := enqueue("mixed", 0)
	urgent := enqueue("mixed", 10)

	claimed, err := store.Claim(ctx, ports.ClaimInput{
		Owner: "worker-1", Now: clock, Limit: 3, LeaseDuration: time.Minute,
	})
	if err != nil || len(claimed) != 3 {
		t.Fatalf("claim: len=%d err=%v", len(claimed), err)
	}
	order := []job.ID{claimed[0].ID, claimed[1].ID, claimed[2].ID}
	want := []job.ID{urgent, firstNormal, secondNormal}
	for index := range want {
		if order[index] != want[index] {
			t.Fatalf("expected priority first then FIFO %v, got %v", want, order)
		}
	}
}

// Without aging, a queue that always has high priority work would never run its
// low priority backlog.
func TestWaitingWorkAgesPastFreshHigherPriorityWork(t *testing.T) {
	base := time.Date(2026, 7, 27, 9, 0, 0, 0, time.UTC)
	clock := base
	store := memory.NewJobStoreWithClock(func() time.Time { return clock })
	ctx := context.Background()

	starved, err := store.Enqueue(ctx, ports.EnqueueInput{Name: "aging", Payload: []byte("{}"), Priority: 0})
	if err != nil {
		t.Fatal(err)
	}
	clock = base.Add(4 * time.Hour)
	if _, err := store.Enqueue(ctx, ports.EnqueueInput{Name: "aging", Payload: []byte("{}"), Priority: 3}); err != nil {
		t.Fatal(err)
	}

	claimed, err := store.Claim(ctx, ports.ClaimInput{
		Owner: "worker-1", Now: clock, Limit: 1, LeaseDuration: time.Minute,
	})
	if err != nil || len(claimed) != 1 {
		t.Fatalf("claim: len=%d err=%v", len(claimed), err)
	}
	if claimed[0].ID != starved {
		t.Fatalf("four hours of waiting should outrank a priority of three, claimed %+v", claimed[0])
	}
}

func TestDelayedJobIsNotClaimedBeforeItsTime(t *testing.T) {
	now := time.Date(2026, 7, 27, 9, 0, 0, 0, time.UTC)
	store := memory.NewJobStoreWithClock(func() time.Time { return now })
	ctx := context.Background()
	if _, err := store.Enqueue(ctx, ports.EnqueueInput{
		Name: "later", Payload: []byte("{}"), RunAfter: time.Hour,
	}); err != nil {
		t.Fatal(err)
	}
	claimed, err := store.Claim(ctx, ports.ClaimInput{
		Owner: "worker-1", Now: now, Limit: 1, LeaseDuration: time.Minute,
	})
	if err != nil || len(claimed) != 0 {
		t.Fatalf("a delayed job must wait: len=%d err=%v", len(claimed), err)
	}
	claimed, err = store.Claim(ctx, ports.ClaimInput{
		Owner: "worker-1", Now: now.Add(time.Hour), Limit: 1, LeaseDuration: time.Minute,
	})
	if err != nil || len(claimed) != 1 {
		t.Fatalf("a delayed job must run once due: len=%d err=%v", len(claimed), err)
	}
}
