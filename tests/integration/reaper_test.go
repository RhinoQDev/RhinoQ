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
	if _, err := store.Enqueue(ctx, ports.EnqueueInput{Name: "reap-me", Payload: []byte("{}")}); err != nil {
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
	id, err := store.Enqueue(ctx, ports.EnqueueInput{Name: "poison", Payload: []byte("{}")})
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
