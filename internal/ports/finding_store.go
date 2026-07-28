package ports

import (
	"context"
	"time"

	"github.com/rhinoq/rhinoq/internal/domain/finding"
)

// FindingStore owns the atomic fold from observations/operator decisions into
// one persistent finding and its append-only history.
type FindingStore interface {
	ObserveFinding(ctx context.Context, observation finding.Observation) (finding.Record, error)
	ObserveFindingPass(ctx context.Context, key finding.Key, observedAt time.Time) (finding.Record, bool, error)
	TransitionFinding(ctx context.Context, key finding.Key, transition finding.Transition) (finding.Record, error)
	GetFinding(ctx context.Context, key finding.Key) (finding.Record, bool, error)
	ListFindings(ctx context.Context, query finding.Query) ([]finding.Record, error)
	ListFindingEvents(ctx context.Context, key finding.Key, offset, limit int) ([]finding.Event, error)
}
