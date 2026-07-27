package ports

import (
	"context"
	"time"

	"github.com/rhinoq/rhinoq/internal/domain/effect"
)

type EffectStore interface {
	BeginEffect(ctx context.Context, record effect.Record) (effect.Record, error)
	GetEffect(ctx context.Context, jobID, name, idempotencyKey string) (effect.Record, bool, error)
	SaveEffect(ctx context.Context, record effect.Record) error
}

type EffectClock interface {
	Now() time.Time
}
