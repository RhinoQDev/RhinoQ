package ports

import (
	"context"

	"github.com/madebyduy/RhinoQ/internal/domain/subjectoutcome"
)

type SubjectOutcomeStore interface {
	GetSubjectOutcome(
		ctx context.Context,
		key subjectoutcome.Key,
	) (subjectoutcome.Record, bool, error)
	// SaveSubjectOutcome returns false when a newer observation is already
	// materialized. Callers must not project that stale observation into a
	// Finding.
	SaveSubjectOutcome(ctx context.Context, record subjectoutcome.Record) (bool, error)
}
