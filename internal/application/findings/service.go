// Package findings coordinates persistent finding observations and operator
// lifecycle decisions. Detection belongs to rule adapters; lifecycle semantics
// remain in the domain.
package findings

import (
	"context"
	"errors"
	"time"

	"github.com/rhinoq/rhinoq/internal/domain/finding"
	"github.com/rhinoq/rhinoq/internal/ports"
)

type Service struct {
	store ports.FindingStore
	now   func() time.Time
}

func New(store ports.FindingStore, now func() time.Time) (*Service, error) {
	if store == nil {
		return nil, errors.New("finding store is required")
	}
	if now == nil {
		now = func() time.Time { return time.Now().UTC() }
	}
	return &Service{store: store, now: now}, nil
}

func (s *Service) Observe(ctx context.Context, observation finding.Observation) (finding.Record, error) {
	if observation.ObservedAt.IsZero() {
		observation.ObservedAt = s.now()
	}
	return s.store.ObserveFinding(ctx, observation)
}

func (s *Service) Transition(
	ctx context.Context,
	key finding.Key,
	transition finding.Transition,
) (finding.Record, error) {
	if err := key.Validate(); err != nil {
		return finding.Record{}, err
	}
	if transition.At.IsZero() {
		transition.At = s.now()
	}
	return s.store.TransitionFinding(ctx, key, transition)
}

func (s *Service) Get(ctx context.Context, key finding.Key) (finding.Record, bool, error) {
	if err := key.Validate(); err != nil {
		return finding.Record{}, false, err
	}
	return s.store.GetFinding(ctx, key)
}

func (s *Service) List(ctx context.Context, query finding.Query) ([]finding.Record, error) {
	if query.Now.IsZero() {
		query.Now = s.now()
	}
	if err := query.Validate(); err != nil {
		return nil, err
	}
	return s.store.ListFindings(ctx, query)
}

func (s *Service) History(
	ctx context.Context,
	key finding.Key,
	offset, limit int,
) ([]finding.Event, error) {
	if err := key.Validate(); err != nil {
		return nil, err
	}
	if offset < 0 || limit <= 0 || limit > 1000 {
		return nil, errors.New("event offset must be non-negative and limit must be between 1 and 1000")
	}
	return s.store.ListFindingEvents(ctx, key, offset, limit)
}
