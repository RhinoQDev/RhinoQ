package integration

import (
	"context"
	"testing"
	"time"

	"github.com/madebyduy/RhinoQ/internal/adapters/memory"
	"github.com/madebyduy/RhinoQ/internal/domain/job"
	"github.com/madebyduy/RhinoQ/internal/ports"
	"github.com/madebyduy/RhinoQ/internal/runtime/lease"
)

func TestReaperRequeuesExpiredLease(t *testing.T) {
	now := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	store := memory.NewJobStoreWithClock(func() time.Time { return now })
	ctx := context.Background()
	if _, err := store.Enqueue(ctx, ports.EnqueueInput{Identity: job.Identity{QueueName: "reap-me", JobName: "reap-me"}, Payload: []byte("{}")}); err != nil {
		t.Fatal(err)
	}
	claimed, err := store.Claim(ctx, ports.ClaimInput{Owner: "worker-1", Now: now, Limit: 1, LeaseDuration: time.Minute})
	if err != nil || len(claimed) != 1 {
		t.Fatalf("claim fixture: len=%d err=%v", len(claimed), err)
	}
	if claimed[0].State.String() != "leased" {
		t.Fatalf("expected leased, got %s", claimed[0].State)
	}

	reaper, err := lease.NewReaper(lease.Config{
		Store: store, Interval: time.Hour, Now: func() time.Time { return now.Add(2 * time.Minute) },
	})
	if err != nil {
		t.Fatal(err)
	}
	result, err := reaper.Sweep(ctx)
	if err != nil || result.Requeued != 1 || result.Blocked != 0 {
		t.Fatalf("expected one requeued job: %+v err=%v", result, err)
	}
	record, ok, err := store.Get(ctx, claimed[0].ID)
	if err != nil || !ok || record.State != job.RetryWait || record.CrashCount != 1 {
		t.Fatalf("expected requeued job with a recorded crash, ok=%v err=%v record=%+v", ok, err, record)
	}
}

// A payload that kills its worker never records a normal failed attempt, so the
// retry policy cannot stop it. The crash budget can.
func TestReaperParksPoisonJobAfterRepeatedCrashes(t *testing.T) {
	now := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	clock := now
	store := memory.NewJobStoreWithClock(func() time.Time { return clock })
	ctx := context.Background()
	id, err := store.Enqueue(ctx, ports.EnqueueInput{Identity: job.Identity{QueueName: "poison", JobName: "poison"}, Payload: []byte("{}")})
	if err != nil {
		t.Fatal(err)
	}
	protection := job.Protection{MaxWorkerCrashesPerJob: 2}

	for crash := 1; crash <= 2; crash++ {
		claimed, err := store.Claim(ctx, ports.ClaimInput{
			Owner: "worker-1", Now: clock, Limit: 1, LeaseDuration: time.Minute,
		})
		if err != nil || len(claimed) != 1 {
			t.Fatalf("claim %d: len=%d err=%v", crash, len(claimed), err)
		}
		clock = clock.Add(2 * time.Minute)
		result, err := store.RequeueExpired(ctx, ports.ReapInput{Now: clock, Protection: protection})
		if err != nil {
			t.Fatal(err)
		}
		if crash < 2 && result.Requeued != 1 {
			t.Fatalf("crash %d should requeue: %+v", crash, result)
		}
		if crash == 2 && result.Blocked != 1 {
			t.Fatalf("crash %d should park the job: %+v", crash, result)
		}
	}

	record, ok, err := store.Get(ctx, id)
	if err != nil || !ok || record.State != job.Blocked || record.BlockedReason != job.BlockedPoisonJob {
		t.Fatalf("expected a parked poison job, ok=%v err=%v record=%+v", ok, err, record)
	}
	claimed, err := store.Claim(ctx, ports.ClaimInput{
		Owner: "worker-2", Now: clock, Limit: 1, LeaseDuration: time.Minute,
	})
	if err != nil || len(claimed) != 0 {
		t.Fatalf("a parked poison job must not reach another worker: len=%d err=%v", len(claimed), err)
	}
}

// A deploy that kills every worker at once expires every lease at once. The
// reaper must never turn that into a single statement over the whole backlog:
// one unbounded UPDATE holds locks and writes WAL in proportion to the outage,
// which is precisely when the database can least afford it.
func TestReaperDrainsAMassExpiryInBoundedBatches(t *testing.T) {
	const leased = 25
	const batch = 4

	now := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	store := memory.NewJobStoreWithClock(func() time.Time { return now })
	ctx := context.Background()
	for index := 0; index < leased; index++ {
		if _, err := store.Enqueue(ctx, ports.EnqueueInput{
			Identity: job.Identity{QueueName: "mass", JobName: "mass"},
			Payload:  []byte("{}"),
		}); err != nil {
			t.Fatal(err)
		}
	}
	claimed, err := store.Claim(ctx, ports.ClaimInput{
		Owner: "worker-1", Now: now, Limit: leased, LeaseDuration: time.Minute,
	})
	if err != nil || len(claimed) != leased {
		t.Fatalf("claim fixture: len=%d err=%v", len(claimed), err)
	}

	expired := now.Add(2 * time.Minute)

	// One batch must stop at its limit and say the backlog outlived it.
	first, err := store.RequeueExpired(ctx, ports.ReapInput{Now: expired, Limit: batch})
	if err != nil {
		t.Fatal(err)
	}
	if len(first.Expired) != batch {
		t.Fatalf("one statement must touch at most %d leases, got %d", batch, len(first.Expired))
	}
	if !first.Saturated {
		t.Fatal("a full batch must report that more expired leases remain")
	}

	// The sweep keeps going until the backlog is drained, in batches.
	reaper, err := lease.NewReaper(lease.Config{
		Store: store, Interval: time.Hour, BatchLimit: batch,
		Now: func() time.Time { return expired },
	})
	if err != nil {
		t.Fatal(err)
	}
	total, err := reaper.Sweep(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if remaining := leased - batch; total.Requeued != remaining {
		t.Fatalf("the sweep must drain the rest of the backlog, want %d got %d", remaining, total.Requeued)
	}
	if total.Saturated {
		t.Fatal("a drained backlog must not report saturation")
	}

	counts, err := store.JobCounts(ctx, "mass")
	if err != nil {
		t.Fatal(err)
	}
	if counts[job.RetryWait] != leased {
		t.Fatalf("every expired lease must be requeued exactly once, got %+v", counts)
	}
}

// The sweep must yield instead of looping forever when the backlog outlasts its
// budget, so a mass expiry cannot starve live claims.
func TestReaperYieldsWhenTheBacklogOutlastsItsBudget(t *testing.T) {
	now := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	store := memory.NewJobStoreWithClock(func() time.Time { return now })
	ctx := context.Background()
	for index := 0; index < 12; index++ {
		if _, err := store.Enqueue(ctx, ports.EnqueueInput{
			Identity: job.Identity{QueueName: "slow-drain", JobName: "slow-drain"},
			Payload:  []byte("{}"),
		}); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := store.Claim(ctx, ports.ClaimInput{
		Owner: "worker-1", Now: now, Limit: 12, LeaseDuration: time.Minute,
	}); err != nil {
		t.Fatal(err)
	}

	// A clock that advances on every read exhausts the budget after one batch.
	reads := 0
	expired := now.Add(2 * time.Minute)
	reaper, err := lease.NewReaper(lease.Config{
		Store: store, Interval: time.Hour, BatchLimit: 2,
		SweepBudget: time.Second,
		Now: func() time.Time {
			reads++
			return expired.Add(time.Duration(reads) * time.Second)
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	total, err := reaper.Sweep(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if !total.Saturated {
		t.Fatal("a sweep that stopped on its budget must report the backlog as unfinished")
	}
	if total.Requeued >= 12 {
		t.Fatalf("the sweep must yield before draining everything, got %d", total.Requeued)
	}
}
