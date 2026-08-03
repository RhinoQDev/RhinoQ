package fault

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/madebyduy/RhinoQ/internal/adapters/memory"
	applicationeffect "github.com/madebyduy/RhinoQ/internal/application/effect"
	domaineffect "github.com/madebyduy/RhinoQ/internal/domain/effect"
	"github.com/madebyduy/RhinoQ/internal/domain/job"
	"github.com/madebyduy/RhinoQ/internal/ports"
)

// The most expensive fault RhinoQ exists to survive: the provider accepted the
// charge and the connection to PostgreSQL died before the ledger recorded it.
//
// AGENTS.md: an unknown external result must fail closed or become uncertain,
// never a blind retry. "Blind retry" here means charging the card again.
func TestAConfirmationLostAfterTheProviderSucceededDoesNotChargeTwice(t *testing.T) {
	now := time.Date(2026, 8, 3, 11, 0, 0, 0, time.UTC)
	jobs := memory.NewJobStoreWithClock(func() time.Time { return now })
	base, err := memory.NewEffectStore(jobs)
	if err != nil {
		t.Fatal(err)
	}
	effects := &faultyEffectStore{
		EffectStore: base,
		injector:    newInjector(faultPlan{operation: "ConfirmEffect", onCall: 1, afterApply: true}),
	}
	ctx := context.Background()
	if _, err := jobs.Enqueue(ctx, ports.EnqueueInput{
		Identity: job.Identity{QueueName: "charge-card", JobName: "charge-card"},
		Payload:  []byte(`{"invoice":"inv_9"}`),
	}); err != nil {
		t.Fatal(err)
	}
	lease := mustClaim(t, jobs, "worker-1", now, time.Minute)
	service := applicationeffect.NewService(effects, func() time.Time { return now })

	record, err := service.Begin(ctx, lease, "effect_1", "charge", "invoice:inv_9", true)
	if err != nil {
		t.Fatal(err)
	}

	// The provider returned success; the ledger write commits and the ack is
	// lost. The worker sees a transport error for a charge that happened.
	if _, err := service.Confirm(ctx, lease, record,
		domaineffect.ConfirmationPolicy{Kind: domaineffect.OnReturn}, "ch_live_1"); !errors.Is(err, errConnectionReset) {
		t.Fatalf("expected the injected fault, got %v", err)
	}

	// The durable ledger is what protects the customer, not the worker's
	// in-memory belief. A retry must find the effect already recorded and
	// refuse to reopen it under the same idempotency key.
	stored, ok, err := base.GetEffect(ctx, record.JobID, record.Name, record.IdempotencyKey)
	if err != nil || !ok {
		t.Fatalf("effect lookup: ok=%v err=%v", ok, err)
	}
	if stored.State == domaineffect.Pending {
		t.Fatalf("the confirmation committed before the fault; the ledger still says %s", stored.State)
	}

	replayed, err := service.Begin(ctx, lease, record.ID, "charge", "invoice:inv_9", true)
	if err != nil {
		t.Fatalf("a deterministic retry must resolve against the ledger, not error: %v", err)
	}
	if replayed.State == domaineffect.Pending {
		t.Fatalf(
			"a retry after a lost confirmation must not reopen the effect as pending; "+
				"that is the second charge. Got %+v",
			replayed,
		)
	}
	if replayed.ID != record.ID || replayed.IdempotencyKey != record.IdempotencyKey {
		t.Fatalf("the retry must resolve to the same ledger entry: %+v", replayed)
	}

	// A retry that invents a fresh effect ID under the same key is a bug in the
	// caller, and the ledger refuses it rather than recording two charges for
	// one invoice. Non-deterministic effect IDs defeat the whole mechanism, so
	// the refusal is the guarantee, not an inconvenience.
	if _, err := service.Begin(ctx, lease, "effect_regenerated", "charge", "invoice:inv_9", true); !errors.Is(err, memory.ErrEffectConflict) {
		t.Fatalf("a non-deterministic retry must be refused, got %v", err)
	}
}

// The worker died with the provider call in flight. Nobody knows whether the
// money moved. The only honest state is uncertain — and it must be reached by
// the reaper, without a lease, because the execution that opened it is gone.
func TestAnEffectOpenWhenTheWorkerDiesBecomesUncertainNotFailed(t *testing.T) {
	now := time.Date(2026, 8, 3, 11, 0, 0, 0, time.UTC)
	jobs := memory.NewJobStoreWithClock(func() time.Time { return now })
	effects, err := memory.NewEffectStore(jobs)
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	if _, err := jobs.Enqueue(ctx, ports.EnqueueInput{
		Identity: job.Identity{QueueName: "charge-card", JobName: "charge-card"},
		Payload:  []byte("{}"),
	}); err != nil {
		t.Fatal(err)
	}
	lease := mustClaim(t, jobs, "worker-doomed", now, time.Minute)
	service := applicationeffect.NewService(effects, func() time.Time { return now })
	record, err := service.Begin(ctx, lease, "effect_1", "charge", "invoice:inv_10", true)
	if err != nil {
		t.Fatal(err)
	}

	// The worker is killed mid-call. The reaper finds the expired lease.
	expired := now.Add(2 * time.Minute)
	result, err := jobs.RequeueExpired(ctx, ports.ReapInput{Now: expired})
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Expired) == 0 {
		t.Fatalf("the sweep must report the expired execution so the ledger can follow it: %+v", result)
	}
	marked, err := effects.MarkPendingUncertain(ctx, result.Expired)
	if err != nil {
		t.Fatal(err)
	}
	if marked != 1 {
		t.Fatalf("expected the open effect to be downgraded, marked=%d", marked)
	}

	stored, ok, err := effects.GetEffect(ctx, record.JobID, record.Name, record.IdempotencyKey)
	if err != nil || !ok {
		t.Fatalf("effect lookup: ok=%v err=%v", ok, err)
	}
	if stored.State != domaineffect.Uncertain {
		t.Fatalf(
			"an effect that was in flight when its worker died must be uncertain, not %s. "+
				"Anything else is a claim nobody can back: failed invites a retry that "+
				"charges twice, succeeded hides a charge that never happened.",
			stored.State,
		)
	}
}

// The next execution must be able to open its own work without the dead
// execution's uncertain entry being silently reused or overwritten.
func TestTheNextExecutionDoesNotInheritAnUncertainEffect(t *testing.T) {
	now := time.Date(2026, 8, 3, 11, 0, 0, 0, time.UTC)
	jobs := memory.NewJobStoreWithClock(func() time.Time { return now })
	effects, err := memory.NewEffectStore(jobs)
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	if _, err := jobs.Enqueue(ctx, ports.EnqueueInput{
		Identity: job.Identity{QueueName: "charge-card", JobName: "charge-card"},
		Payload:  []byte("{}"),
	}); err != nil {
		t.Fatal(err)
	}
	dead := mustClaim(t, jobs, "worker-doomed", now, time.Minute)
	deadService := applicationeffect.NewService(effects, func() time.Time { return now })
	opened, err := deadService.Begin(ctx, dead, "effect_1", "charge", "invoice:inv_11", true)
	if err != nil {
		t.Fatal(err)
	}

	expired := now.Add(2 * time.Minute)
	result, err := jobs.RequeueExpired(ctx, ports.ReapInput{Now: expired})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := effects.MarkPendingUncertain(ctx, result.Expired); err != nil {
		t.Fatal(err)
	}
	next := mustClaim(t, jobs, "worker-next", expired, time.Minute)

	nextService := applicationeffect.NewService(effects, func() time.Time { return expired })
	// The new execution recomputes the same deterministic effect identity: same
	// invoice, same effect. That is what lets it find the dead execution's entry
	// instead of starting a second charge.
	replayed, err := nextService.Begin(ctx, next, opened.ID, "charge", "invoice:inv_11", true)
	if err != nil {
		t.Fatalf("the new execution must be able to consult the ledger: %v", err)
	}
	if replayed.State == domaineffect.Pending {
		t.Fatalf(
			"the new execution must not silently take over an uncertain effect as "+
				"pending work; that discards the only record that the money may already "+
				"have moved. Got %+v",
			replayed,
		)
	}
	if replayed.LeaseEpoch != dead.Epoch {
		t.Fatalf(
			"the ledger entry must keep the epoch of the execution that opened it, "+
				"got %d want %d",
			replayed.LeaseEpoch, dead.Epoch,
		)
	}
}
