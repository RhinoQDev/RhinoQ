package ports

import (
	"context"
	"time"

	"github.com/rhinoq/rhinoq/internal/domain/effect"
)

// EffectStore records external side effects. Opening and confirming an effect
// are worker-authored transitions, so both carry the fencing token: a worker
// that already lost its lease must not be able to start spending real money
// (specification 41.3 and 50.2).
type EffectStore interface {
	// CheckLease lets the application reject stale executions before applying
	// domain transitions whose error would otherwise hide the lost fence.
	CheckLease(ctx context.Context, lease Lease, now time.Time) error
	BeginEffect(ctx context.Context, lease Lease, now time.Time, record effect.Record) (effect.Record, error)
	GetEffect(ctx context.Context, jobID, name, idempotencyKey string) (effect.Record, bool, error)
	ConfirmEffect(ctx context.Context, lease Lease, now time.Time, record effect.Record) error
	// SaveEffect persists a transition authored by RhinoQ itself rather than by
	// a worker - the reaper moving a pending effect to uncertain after the lease
	// died. There is no lease left to fence against at that point.
	SaveEffect(ctx context.Context, record effect.Record) error
	// MarkPendingUncertain downgrades every effect that a dead execution left
	// open. An effect that was in flight when its worker died may or may not
	// have reached the provider, and pretending otherwise is what makes a queue
	// charge a card twice. Only effects at or below the given epoch are touched,
	// so work opened by the next execution is left alone.
	MarkPendingUncertain(ctx context.Context, expired []ExpiredLease) (int, error)
}

// EffectReader is the bounded, read-only evidence capability used by
// developer tooling. It stays separate from EffectStore so a runtime adapter
// can implement correctness writes without also promising an inspection
// surface.
type EffectReader interface {
	ListEffects(ctx context.Context, jobID string, offset, limit int) ([]effect.Record, error)
}

type EffectClock interface {
	Now() time.Time
}
