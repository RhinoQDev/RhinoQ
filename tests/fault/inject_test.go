// Package fault holds the fault-injection evidence.
//
// AGENTS.md forbids a reliability claim without fault evidence, and this
// directory was empty. By RhinoQ's own rule that meant RhinoQ was not entitled
// to say anything about what happens when a database drops mid-transaction, a
// lease expires under a worker that is still alive, or an acknowledgement is
// lost after the write committed.
//
// The tests here inject those faults at the port boundary and assert what the
// system does. They are not benchmarks and make no throughput claim; the
// question is only whether a durable outcome survives the fault or turns into a
// silent double-effect.
package fault

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/madebyduy/RhinoQ/internal/domain/effect"
	"github.com/madebyduy/RhinoQ/internal/ports"
)

// errConnectionReset stands in for what a driver actually returns when the
// database goes away: an opaque transport error carrying no information about
// whether the transaction committed. That ambiguity is the entire problem —
// a store that treats it as "did not happen" is how a card gets charged twice.
var errConnectionReset = errors.New("read tcp 10.0.0.4:54312->10.0.0.9:5432: connection reset by peer")

// faultPlan fails a named operation on a chosen call, optionally after the
// underlying store has already applied it.
//
// afterApply is the distinction that matters. A failure before the write is
// benign: nothing happened and the caller can retry freely. A failure after the
// commit but before the acknowledgement leaves the caller unable to tell the
// two apart, and that is the case every at-least-once system actually has to
// survive.
type faultPlan struct {
	operation  string
	onCall     int
	afterApply bool
}

type faultInjector struct {
	plan  faultPlan
	calls map[string]int
}

func newInjector(plan faultPlan) *faultInjector {
	return &faultInjector{plan: plan, calls: map[string]int{}}
}

// before reports whether this call must fail without touching the store.
func (f *faultInjector) before(operation string) error {
	f.calls[operation]++
	if f.plan.afterApply || !f.matches(operation) {
		return nil
	}
	return errConnectionReset
}

// after reports whether this call must fail even though the store applied it.
func (f *faultInjector) after(operation string) error {
	if !f.plan.afterApply || !f.matches(operation) {
		return nil
	}
	return errConnectionReset
}

func (f *faultInjector) matches(operation string) bool {
	return f.plan.operation == operation && f.calls[operation] == f.plan.onCall
}

// faultyJobStore wraps a real JobStore. Only the operations the fault tests
// drive are decorated; the rest delegate unchanged, so a scenario cannot pass
// by accidentally bypassing the store under test.
type faultyJobStore struct {
	ports.JobStore
	injector *faultInjector
}

func (s *faultyJobStore) Enqueue(ctx context.Context, input ports.EnqueueInput) (ports.JobID, error) {
	if err := s.injector.before("Enqueue"); err != nil {
		return "", err
	}
	id, err := s.JobStore.Enqueue(ctx, input)
	if err != nil {
		return id, err
	}
	if err := s.injector.after("Enqueue"); err != nil {
		// The row is committed and the caller will never learn its ID.
		return "", err
	}
	return id, nil
}

func (s *faultyJobStore) Complete(ctx context.Context, lease ports.Lease, now time.Time) error {
	if err := s.injector.before("Complete"); err != nil {
		return err
	}
	if err := s.JobStore.Complete(ctx, lease, now); err != nil {
		return err
	}
	return s.injector.after("Complete")
}

func (s *faultyJobStore) RenewLease(
	ctx context.Context, lease ports.Lease, now time.Time, extension time.Duration,
) (ports.LeaseStatus, error) {
	if err := s.injector.before("RenewLease"); err != nil {
		return ports.LeaseStatus{}, err
	}
	return s.JobStore.RenewLease(ctx, lease, now, extension)
}

func (s *faultyJobStore) RequeueExpired(ctx context.Context, input ports.ReapInput) (ports.ReapResult, error) {
	if err := s.injector.before("RequeueExpired"); err != nil {
		return ports.ReapResult{}, err
	}
	return s.JobStore.RequeueExpired(ctx, input)
}

// faultyEffectStore is the ledger half. Confirmation is the interesting one:
// a provider call that returned while the connection to PostgreSQL was gone
// leaves an effect that really happened recorded as if it might not have.
type faultyEffectStore struct {
	ports.EffectStore
	injector *faultInjector
}

func (s *faultyEffectStore) ConfirmEffect(
	ctx context.Context, lease ports.Lease, now time.Time, record effect.Record,
) error {
	if err := s.injector.before("ConfirmEffect"); err != nil {
		return err
	}
	if err := s.EffectStore.ConfirmEffect(ctx, lease, now, record); err != nil {
		return err
	}
	return s.injector.after("ConfirmEffect")
}

func mustClaim(t *testing.T, store ports.JobStore, owner string, now time.Time, lease time.Duration) ports.Lease {
	t.Helper()
	claimed, err := store.Claim(context.Background(), ports.ClaimInput{
		Owner: owner, Now: now, Limit: 1, LeaseDuration: lease,
	})
	if err != nil {
		t.Fatalf("claim for %s: %v", owner, err)
	}
	if len(claimed) != 1 {
		t.Fatalf("expected %s to claim exactly one job, got %d", owner, len(claimed))
	}
	return ports.LeaseFor(claimed[0])
}
