package ports

import (
	"context"
	"time"

	"github.com/madebyduy/RhinoQ/internal/domain/finding"
)

// FindingStore owns the atomic fold from observations/operator decisions into
// one persistent finding and its append-only history.
type FindingStore interface {
	ObserveFinding(ctx context.Context, observation finding.Observation) (finding.Record, error)
	ObserveFindingPass(ctx context.Context, key finding.Key, observedAt time.Time) (finding.Record, bool, error)
	// GetFindingsForSubjects reads the Findings that already exist for one
	// evaluated page, keyed by subject id.
	//
	// A pass only ever changes something when a Finding is already open, and in
	// a healthy system almost no subject has one. Without this read, every
	// passing subject opened a transaction, took an advisory lock and issued a
	// SELECT ... FOR UPDATE to discover there was nothing to resolve.
	GetFindingsForSubjects(
		ctx context.Context,
		keys []finding.Key,
	) (map[string]finding.Record, error)
	TransitionFinding(ctx context.Context, key finding.Key, transition finding.Transition) (finding.Record, error)
	GetFinding(ctx context.Context, key finding.Key) (finding.Record, bool, error)
	ListFindings(ctx context.Context, query finding.Query) ([]finding.Record, error)
	ListFindingEvents(ctx context.Context, key finding.Key, offset, limit int) ([]finding.Event, error)
}
