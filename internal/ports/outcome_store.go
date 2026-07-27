package ports

import (
	"context"
	"time"

	"github.com/rhinoq/rhinoq/internal/domain/outcome"
)

type OutcomeStore interface {
	SaveOutcome(ctx context.Context, record outcome.Record) error
	GetOutcome(ctx context.Context, id string) (outcome.Record, bool, error)
}

type OutcomeVerifier interface {
	Verify(ctx context.Context, jobID string, contract outcome.Contract) (outcome.Observation, error)
}

type OutcomeClock interface {
	Now() time.Time
}
