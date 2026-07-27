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

type EffectClock interface {
	Now() time.Time
}
