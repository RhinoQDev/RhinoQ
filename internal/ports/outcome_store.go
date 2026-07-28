package ports

import (
	"context"
	"time"

	"github.com/madebyduy/RhinoQ/internal/domain/outcome"
)

type OutcomeStore interface {
	SaveOutcome(ctx context.Context, record outcome.Record) error
	GetOutcome(ctx context.Context, id string) (outcome.Record, bool, error)
}

// OutcomeReader exposes bounded verification evidence without coupling a
// developer interface to a concrete database adapter.
type OutcomeReader interface {
	ListOutcomes(ctx context.Context, jobID string, offset, limit int) ([]outcome.Record, error)
}

type OutcomeVerifier interface {
	Verify(ctx context.Context, jobID string, contract outcome.Contract) (outcome.Observation, error)
}

type OutcomeClock interface {
	Now() time.Time
}
