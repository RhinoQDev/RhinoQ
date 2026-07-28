package integration

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/madebyduy/RhinoQ/internal/adapters/memory"
	applicationeffect "github.com/madebyduy/RhinoQ/internal/application/effect"
	"github.com/madebyduy/RhinoQ/internal/domain/effect"
	"github.com/madebyduy/RhinoQ/internal/ports"
	"github.com/madebyduy/RhinoQ/internal/runtime/lease"
)

// Opening an effect is the last point at which RhinoQ can stop a worker that
// already lost its job from spending real money a second time.
func TestStaleExecutionCannotOpenOrConfirmAnEffect(t *testing.T) {
	now := time.Date(2026, 7, 27, 16, 0, 0, 0, time.UTC)
	jobs := memory.NewJobStoreWithClock(func() time.Time { return now })
	effects, err := memory.NewEffectStore(jobs)
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	if _, err := jobs.Enqueue(ctx, ports.EnqueueInput{Name: "charge-card", Payload: []byte("{}")}); err != nil {
		t.Fatal(err)
	}
	claimed, err := jobs.Claim(ctx, ports.ClaimInput{Owner: "worker-1", Now: now, Limit: 1, LeaseDuration: time.Minute})
	if err != nil || len(claimed) != 1 {
		t.Fatalf("claim fixture: len=%d err=%v", len(claimed), err)
	}
	stale := ports.LeaseFor(claimed[0])

	service := applicationeffect.NewService(effects, func() time.Time { return now })
	record, err := service.Begin(ctx, stale, "effect_1", "charge", "charge:1", true)
	if err != nil {
		t.Fatalf("the live execution must be able to open its effect: %v", err)
	}
	if record.LeaseEpoch != stale.Epoch {
		t.Fatalf("the ledger must record which execution opened the effect: %+v", record)
	}

	// The lease dies and the job is handed to the next worker.
	expired := now.Add(2 * time.Minute)
	if _, err := jobs.RequeueExpired(ctx, ports.ReapInput{Now: expired}); err != nil {
		t.Fatal(err)
	}
	if _, err := jobs.Claim(ctx, ports.ClaimInput{
		Owner: "worker-2", Now: expired, Limit: 1, LeaseDuration: time.Minute,
	}); err != nil {
		t.Fatal(err)
	}

	staleService := applicationeffect.NewService(effects, func() time.Time { return expired.Add(time.Second) })
	if _, err := staleService.Begin(ctx, stale, "effect_2", "charge", "charge:2", true); !errors.Is(err, ports.ErrLeaseLost) {
		t.Fatalf("a stale execution must not open a new effect, got %v", err)
	}
	if _, err := staleService.Confirm(ctx, stale, record,
		effect.ConfirmationPolicy{Kind: effect.OnReturn}, "provider-ref"); !errors.Is(err, ports.ErrLeaseLost) {
		t.Fatalf("a stale execution must not confirm an effect, got %v", err)
	}

	stored, ok, err := effects.GetEffect(ctx, record.JobID, record.Name, record.IdempotencyKey)
	if err != nil || !ok || stored.State != effect.Pending {
		t.Fatalf("the effect must stay unconfirmed: ok=%v err=%v record=%+v", ok, err, stored)
	}
}

// A worker that dies mid-charge leaves an effect whose result nobody knows.
// Leaving it pending would let the next attempt charge again, so the sweep that
// requeues the job downgrades the effect in the same pass.
func TestReaperDowngradesEffectsLeftOpenByDeadExecutions(t *testing.T) {
	now := time.Date(2026, 7, 27, 17, 0, 0, 0, time.UTC)
	clock := now
	jobs := memory.NewJobStoreWithClock(func() time.Time { return clock })
	effects, err := memory.NewEffectStore(jobs)
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	if _, err := jobs.Enqueue(ctx, ports.EnqueueInput{Name: "charge-card", Payload: []byte("{}")}); err != nil {
		t.Fatal(err)
	}
	claimed, err := jobs.Claim(ctx, ports.ClaimInput{Owner: "worker-1", Now: now, Limit: 1, LeaseDuration: time.Minute})
	if err != nil || len(claimed) != 1 {
		t.Fatalf("claim fixture: len=%d err=%v", len(claimed), err)
	}
	service := applicationeffect.NewService(effects, func() time.Time { return now })
	opened, err := service.Begin(ctx, ports.LeaseFor(claimed[0]), "effect_1", "charge", "charge:1", true)
	if err != nil {
		t.Fatal(err)
	}

	clock = now.Add(2 * time.Minute)
	reaper, err := lease.NewReaper(lease.Config{
		Store: jobs, Effects: effects, Interval: time.Hour, Now: func() time.Time { return clock },
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := reaper.Sweep(ctx); err != nil {
		t.Fatal(err)
	}

	stored, ok, err := effects.GetEffect(ctx, opened.JobID, opened.Name, opened.IdempotencyKey)
	if err != nil || !ok || stored.State != effect.Uncertain {
		t.Fatalf("an abandoned effect must be downgraded to uncertain: ok=%v err=%v record=%+v", ok, err, stored)
	}

	// The next execution opens its own effect, and a later sweep must not touch
	// it: the epoch bound is what separates the two.
	next, err := jobs.Claim(ctx, ports.ClaimInput{Owner: "worker-2", Now: clock, Limit: 1, LeaseDuration: time.Minute})
	if err != nil || len(next) != 1 {
		t.Fatalf("second claim: len=%d err=%v", len(next), err)
	}
	fresh, err := applicationeffect.NewService(effects, func() time.Time { return clock }).
		Begin(ctx, ports.LeaseFor(next[0]), "effect_2", "refund", "refund:1", true)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := effects.MarkPendingUncertain(ctx, []ports.ExpiredLease{
		{JobID: next[0].ID, Epoch: claimed[0].LeaseEpoch},
	}); err != nil {
		t.Fatal(err)
	}
	live, ok, err := effects.GetEffect(ctx, fresh.JobID, fresh.Name, fresh.IdempotencyKey)
	if err != nil || !ok || live.State != effect.Pending {
		t.Fatalf("an effect from the live execution must be left alone: ok=%v err=%v record=%+v", ok, err, live)
	}
}

// RhinoQ itself has no lease when it downgrades an abandoned effect, so that
// path stays open while the worker path stays fenced.
func TestSystemCanMarkAbandonedEffectUncertain(t *testing.T) {
	now := time.Date(2026, 7, 27, 16, 0, 0, 0, time.UTC)
	jobs := memory.NewJobStoreWithClock(func() time.Time { return now })
	effects, err := memory.NewEffectStore(jobs)
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	if _, err := jobs.Enqueue(ctx, ports.EnqueueInput{Name: "payout", Payload: []byte("{}")}); err != nil {
		t.Fatal(err)
	}
	claimed, err := jobs.Claim(ctx, ports.ClaimInput{Owner: "worker-1", Now: now, Limit: 1, LeaseDuration: time.Minute})
	if err != nil || len(claimed) != 1 {
		t.Fatalf("claim fixture: len=%d err=%v", len(claimed), err)
	}
	service := applicationeffect.NewService(effects, func() time.Time { return now })
	record, err := service.Begin(ctx, ports.LeaseFor(claimed[0]), "effect_1", "payout", "payout:1", true)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := jobs.RequeueExpired(ctx, ports.ReapInput{Now: now.Add(2 * time.Minute)}); err != nil {
		t.Fatal(err)
	}
	updated, err := service.MarkUncertain(ctx, record)
	if err != nil || updated.State != effect.Uncertain {
		t.Fatalf("an abandoned effect must become uncertain: %+v err=%v", updated, err)
	}
}
