package integration

import (
	"context"
	"testing"
	"time"

	"github.com/madebyduy/RhinoQ/internal/adapters/memory"
	"github.com/madebyduy/RhinoQ/internal/application/operations"
	"github.com/madebyduy/RhinoQ/internal/domain/job"
	"github.com/madebyduy/RhinoQ/internal/ports"
)

// The idle worker loop asks one question — "how long until any lane I am
// subscribed to opens up" — and used to ask it once per lane. These tests pin
// the batched answer to the per-lane answer it replaced, because a difference
// between them is a worker that either spins or oversleeps.

// exhaust drives a lane into its throttled state at exactly `now`, so the
// window it is waiting on starts at a time the assertions can reason about.
func exhaust(
	t *testing.T,
	store *memory.JobStore,
	now time.Time,
	queue string,
	max int,
	window time.Duration,
) {
	t.Helper()
	control, err := operations.NewQueueControl(store)
	if err != nil {
		t.Fatal(err)
	}
	if err := control.SetRateLimit(context.Background(), queue, max, window); err != nil {
		t.Fatal(err)
	}
	for index := 0; index <= max; index++ {
		if _, err := store.Enqueue(context.Background(), ports.EnqueueInput{
			Identity: job.Identity{QueueName: queue, JobName: queue},
			Payload:  []byte("{}"),
		}); err != nil {
			t.Fatal(err)
		}
	}
	claimed, err := store.Claim(context.Background(), ports.ClaimInput{
		Owner: "worker-" + queue, Now: now, Limit: max + 1, LeaseDuration: time.Minute,
		QueueNames: []string{queue},
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(claimed) != max {
		t.Fatalf("lane %q: claimed %d, want the full allowance %d", queue, len(claimed), max)
	}
}

func TestNextRateLimitTTLReturnsTheEarliestThrottledLane(t *testing.T) {
	now := time.Date(2026, 8, 17, 10, 0, 0, 0, time.UTC)
	store := memory.NewJobStoreWithClock(func() time.Time { return now })

	exhaust(t, store, now, "slow", 1, 10*time.Minute)
	exhaust(t, store, now, "fast", 1, 2*time.Minute)

	ttl, err := store.NextQueueRateLimitTTL(context.Background(), []string{"slow", "fast"}, now)
	if err != nil {
		t.Fatal(err)
	}
	if ttl != 2*time.Minute {
		t.Fatalf("batched TTL = %s, want the earliest window (2m); sleeping for the slowest lane starves the fast one", ttl)
	}
}

func TestNextRateLimitTTLIgnoresLanesThatAreNotThrottled(t *testing.T) {
	now := time.Date(2026, 8, 17, 10, 0, 0, 0, time.UTC)
	store := memory.NewJobStoreWithClock(func() time.Time { return now })
	exhaust(t, store, now, "throttled", 1, 5*time.Minute)

	ttl, err := store.NextQueueRateLimitTTL(
		context.Background(), []string{"open", "throttled", "also-open"}, now)
	if err != nil {
		t.Fatal(err)
	}
	if ttl != 5*time.Minute {
		t.Fatalf("batched TTL = %s, want 5m from the only throttled lane", ttl)
	}
}

// An elapsed window is not something to wait for; it is something to claim from
// now. Returning it would put the worker to sleep at the exact moment work
// became available.
func TestNextRateLimitTTLIgnoresElapsedWindows(t *testing.T) {
	now := time.Date(2026, 8, 17, 10, 0, 0, 0, time.UTC)
	store := memory.NewJobStoreWithClock(func() time.Time { return now })
	exhaust(t, store, now, "expired", 1, time.Minute)

	ttl, err := store.NextQueueRateLimitTTL(
		context.Background(), []string{"expired"}, now.Add(90*time.Second))
	if err != nil {
		t.Fatal(err)
	}
	if ttl != 0 {
		t.Fatalf("batched TTL = %s, want 0 for a window that already elapsed", ttl)
	}
}

func TestNextRateLimitTTLIsZeroWithoutLanes(t *testing.T) {
	now := time.Date(2026, 8, 17, 10, 0, 0, 0, time.UTC)
	store := memory.NewJobStoreWithClock(func() time.Time { return now })
	ttl, err := store.NextQueueRateLimitTTL(context.Background(), nil, now)
	if err != nil {
		t.Fatal(err)
	}
	if ttl != 0 {
		t.Fatalf("a worker with no subscriptions has nothing to wait for, got %s", ttl)
	}
}

// The batched answer must agree with the per-lane answer it replaced.
func TestNextRateLimitTTLAgreesWithPerLaneQuery(t *testing.T) {
	now := time.Date(2026, 8, 17, 10, 0, 0, 0, time.UTC)
	store := memory.NewJobStoreWithClock(func() time.Time { return now })
	exhaust(t, store, now, "a", 1, 7*time.Minute)
	exhaust(t, store, now, "b", 1, 3*time.Minute)
	lanes := []string{"a", "b", "c"}

	var perLane time.Duration
	for _, name := range lanes {
		ttl, err := store.QueueRateLimitTTL(context.Background(), name, now)
		if err != nil {
			t.Fatal(err)
		}
		if ttl > 0 && (perLane == 0 || ttl < perLane) {
			perLane = ttl
		}
	}

	batched, err := store.NextQueueRateLimitTTL(context.Background(), lanes, now)
	if err != nil {
		t.Fatal(err)
	}
	if batched != perLane {
		t.Fatalf("batched %s does not match per-lane %s", batched, perLane)
	}
}
