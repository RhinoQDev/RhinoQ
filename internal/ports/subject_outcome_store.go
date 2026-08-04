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

	// GetSubjectOutcomes reads a whole evaluated page in one round trip.
	//
	// A Rule page is one Rule version and one subject type by construction, so
	// the result is keyed by subject id. Reading these one at a time made a
	// healthy subject — the overwhelming majority — cost a network round trip to
	// learn nothing had changed.
	//
	// Subjects with no materialized state are absent from the map rather than
	// present and zero, so a caller can still tell "never observed" from
	// "observed and passed".
	GetSubjectOutcomes(
		ctx context.Context,
		keys []subjectoutcome.Key,
	) (map[string]subjectoutcome.Record, error)

	// SaveSubjectOutcomes writes a page in one statement and reports, per
	// subject id, whether the write won against what was already stored. A
	// subject that is absent from the result lost to a newer observation and
	// must not be projected into a Finding, exactly as with SaveSubjectOutcome.
	SaveSubjectOutcomes(
		ctx context.Context,
		records []subjectoutcome.Record,
	) (map[string]bool, error)
}
