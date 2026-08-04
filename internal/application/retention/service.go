// Package retention reclaims evidence that has outlived the window an operator
// chose to keep it for.
//
// RhinoQ does not pick that window. Retention has to outlive the longest
// provider dispute, audit and repair window an adopter is subject to, and no
// default can know what those are. What this package guarantees is that once a
// window is chosen, deleting inside it is bounded and previewable.
package retention

import (
	"context"
	"errors"
	"strings"
	"time"

	"github.com/madebyduy/RhinoQ/internal/ports"
)

// MinimumAge is the youngest cutoff the service will accept.
//
// It is not a legal opinion. It exists because the only retention mistake that
// cannot be undone is deleting evidence of an incident that is still open, and
// a mistyped `--older-than 1h` against production should not be able to do that
// silently.
const MinimumAge = 24 * time.Hour

// DefaultBatch keeps each delete statement short enough that it never becomes
// the longest lock on the table a running scan is writing to.
const DefaultBatch = 5000

type Service struct {
	store ports.RetentionStore
	now   func() time.Time
}

func New(store ports.RetentionStore, now func() time.Time) (*Service, error) {
	if store == nil {
		return nil, errors.New("a retention store is required")
	}
	if now == nil {
		now = func() time.Time { return time.Now().UTC() }
	}
	return &Service{store: store, now: now}, nil
}

type Request struct {
	// OlderThan is the age at which evidence becomes prunable.
	OlderThan time.Duration
	// RuleID narrows the subject-outcome and finding-history targets to one
	// Rule. Empty means every Rule.
	RuleID string
	Batch  int
	// Apply performs the delete. Without it the service reports the plan and
	// changes nothing, which is the same shape as `rules delete`.
	Apply bool
}

type Result struct {
	Plan    ports.RetentionPlan
	Applied bool
}

func (s *Service) Prune(ctx context.Context, request Request) (Result, error) {
	if request.OlderThan < MinimumAge {
		return Result{}, errors.New(
			"retention refuses a cutoff younger than 24h: evidence of an open incident is not recoverable once deleted",
		)
	}
	batch := request.Batch
	if batch == 0 {
		batch = DefaultBatch
	}
	if batch < 1 || batch > 100000 {
		return Result{}, errors.New("retention batch must be between 1 and 100000")
	}
	cutoff := s.now().Add(-request.OlderThan)
	ruleID := strings.TrimSpace(request.RuleID)

	if !request.Apply {
		plan, err := s.store.PlanRetention(ctx, cutoff, ruleID)
		return Result{Plan: plan}, err
	}
	plan, err := s.store.PruneRetention(ctx, cutoff, ruleID, batch)
	return Result{Plan: plan, Applied: err == nil}, err
}
