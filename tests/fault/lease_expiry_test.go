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

// The worker did not crash. It is alive, still holding the payload, still
// running the handler — and its lease expired anyway, because the handler took
// longer than the lease or its heartbeat could not reach PostgreSQL.
//
// This is the fault that produces two live executions of one job. Everything
// after the expiry depends on the fence refusing the first worker's writes.
func TestALiveWorkerLosesItsJobWhenTheLeaseExpires(t *testing.T) {
	now := time.Date(2026, 8, 3, 10, 0, 0, 0, time.UTC)
	store := memory.NewJobStoreWithClock(func() time.Time { return now })
	ctx := context.Background()
	id, err := store.Enqueue(ctx, ports.EnqueueInput{
		Identity: job.Identity{QueueName: "render-video", JobName: "render-video"},
		Payload:  []byte("{}"),
	})
	if err != nil {
		t.Fatal(err)
	}

	slow := mustClaim(t, store, "worker-slow", now, time.Minute)

	// The lease expires while the handler is still running.
	expired := now.Add(90 * time.Second)
	if _, err := store.RequeueExpired(ctx, ports.ReapInput{Now: expired}); err != nil {
		t.Fatal(err)
	}
	fresh := mustClaim(t, store, "worker-fresh", expired, time.Minute)
	if fresh.Epoch <= slow.Epoch {
		t.Fatalf("the new execution must carry a higher epoch: slow=%d fresh=%d", slow.Epoch, fresh.Epoch)
	}

	// Everything the slow worker does from here has to be refused. It does not
	// know it lost the job, so it will try all of these.
	late := expired.Add(30 * time.Second)
	if _, err := store.RenewLease(ctx, slow, late, time.Minute); !errors.Is(err, ports.ErrLeaseLost) {
		t.Fatalf("a stale heartbeat must be refused, got %v", err)
	}
	if err := store.Complete(ctx, slow, late); !errors.Is(err, ports.ErrLeaseLost) {
		t.Fatalf("a stale completion must be refused, got %v", err)
	}
	if err := store.Fail(ctx, slow, late, ports.FailureTransition{
		State: job.RetryWait, RetryIn: time.Minute, FailureClass: "transient",
	}); !errors.Is(err, ports.ErrLeaseLost) {
		t.Fatalf("a stale failure must be refused, got %v", err)
	}

	// The live execution still owns the job and can finish it.
	if err := store.Complete(ctx, fresh, late.Add(time.Second)); err != nil {
		t.Fatalf("the current execution must still be able to complete: %v", err)
	}
	record, ok, err := store.Get(ctx, id)
	if err != nil || !ok {
		t.Fatalf("job lookup: ok=%v err=%v", ok, err)
	}
	if record.State.String() != "succeeded" {
		t.Fatalf("expected the live execution's outcome, got %s", record.State)
	}
}

// A partition is not a crash: the worker keeps running, the heartbeats keep
// failing, and then the network heals. The dangerous outcome is a renewal that
// succeeds afterwards, because the worker would conclude it still owns a job
// another worker is already running.
func TestHeartbeatsThatFailThroughAPartitionNeverRecoverTheLease(t *testing.T) {
	now := time.Date(2026, 8, 3, 10, 0, 0, 0, time.UTC)
	base := memory.NewJobStoreWithClock(func() time.Time { return now })
	injector := newInjector(faultPlan{operation: "RenewLease", onCall: 1})
	store := &faultyJobStore{JobStore: base, injector: injector}
	ctx := context.Background()
	if _, err := base.Enqueue(ctx, ports.EnqueueInput{
		Identity: job.Identity{QueueName: "sync-data", JobName: "sync-data"},
		Payload:  []byte("{}"),
	}); err != nil {
		t.Fatal(err)
	}
	partitioned := mustClaim(t, store, "worker-partitioned", now, time.Minute)

	// The heartbeat cannot reach PostgreSQL.
	if _, err := store.RenewLease(ctx, partitioned, now.Add(20*time.Second), time.Minute); !errors.Is(err, errConnectionReset) {
		t.Fatalf("expected the injected partition, got %v", err)
	}

	// The reaper hands the job on while the worker is still alive and blind.
	expired := now.Add(70 * time.Second)
	if _, err := base.RequeueExpired(ctx, ports.ReapInput{Now: expired}); err != nil {
		t.Fatal(err)
	}
	mustClaim(t, base, "worker-fresh", expired, time.Minute)

	// The network heals. This renewal must not succeed.
	if _, err := store.RenewLease(ctx, partitioned, expired.Add(time.Second), time.Minute); !errors.Is(err, ports.ErrLeaseLost) {
		t.Fatalf(
			"a healed connection must not restore a lease another execution now owns, got %v",
			err,
		)
	}
}

// A mass expiry — a deploy that killed every worker — is reaped in bounded
// batches. If the connection drops mid-sweep, the next sweep must pick up the
// remainder rather than leaving jobs stranded in a leased state nobody holds.
func TestASweepInterruptedByAConnectionLossLosesNoJob(t *testing.T) {
	now := time.Date(2026, 8, 3, 10, 0, 0, 0, time.UTC)
	base := memory.NewJobStoreWithClock(func() time.Time { return now })
	injector := newInjector(faultPlan{operation: "RequeueExpired", onCall: 2})
	store := &faultyJobStore{JobStore: base, injector: injector}
	ctx := context.Background()

	const total = 7
	for i := 0; i < total; i++ {
		if _, err := base.Enqueue(ctx, ports.EnqueueInput{
			Identity: job.Identity{QueueName: "bulk", JobName: "bulk"},
			Payload:  []byte("{}"),
		}); err != nil {
			t.Fatal(err)
		}
	}
	claimed, err := base.Claim(ctx, ports.ClaimInput{
		Owner: "doomed", Now: now, Limit: total, LeaseDuration: time.Minute,
	})
	if err != nil || len(claimed) != total {
		t.Fatalf("claim fixture: len=%d err=%v", len(claimed), err)
	}

	expired := now.Add(2 * time.Minute)
	first, err := store.RequeueExpired(ctx, ports.ReapInput{Now: expired, Limit: 3})
	if err != nil {
		t.Fatal(err)
	}
	if first.Requeued != 3 || !first.Saturated {
		t.Fatalf("expected a saturated first batch of 3, got %+v", first)
	}

	// The second sweep loses the connection.
	if _, err := store.RequeueExpired(ctx, ports.ReapInput{Now: expired, Limit: 3}); !errors.Is(err, errConnectionReset) {
		t.Fatalf("expected the injected fault, got %v", err)
	}

	// Drain what is left. Nothing may stay leased by the dead worker.
	requeued := first.Requeued
	for attempts := 0; attempts < 10; attempts++ {
		result, err := store.RequeueExpired(ctx, ports.ReapInput{Now: expired, Limit: 3})
		if err != nil {
			t.Fatal(err)
		}
		requeued += result.Requeued
		if !result.Saturated {
			break
		}
	}
	if requeued != total {
		t.Fatalf("an interrupted sweep must strand no job: requeued %d of %d", requeued, total)
	}

	// Every job must be claimable again by a live worker.
	recovered, err := base.Claim(ctx, ports.ClaimInput{
		Owner: "survivor", Now: expired.Add(time.Second), Limit: total, LeaseDuration: time.Minute,
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(recovered) != total {
		t.Fatalf("expected all %d jobs back in circulation, got %d", total, len(recovered))
	}
}
