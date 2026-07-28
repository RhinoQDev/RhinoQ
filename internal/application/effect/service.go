package effect

import (
	"context"
	"errors"
	"time"

	domaineffect "github.com/rhinoq/rhinoq/internal/domain/effect"
	"github.com/rhinoq/rhinoq/internal/ports"
)

var ErrEffectStoreRequired = errors.New("effect store is required")

type Service struct {
	store ports.EffectStore
	clock func() time.Time
}

func NewService(store ports.EffectStore, clock func() time.Time) *Service {
	return &Service{store: store, clock: clock}
}

// Begin opens an effect on behalf of a running execution. The lease travels with
// the call: an execution that lost its job must not be able to start a payment.
func (s *Service) Begin(ctx context.Context, lease ports.Lease, id domaineffect.ID, name, key string, irreversible bool) (domaineffect.Record, error) {
	if s == nil || s.store == nil || s.clock == nil {
		return domaineffect.Record{}, ErrEffectStoreRequired
	}
	now := s.clock()
	record, err := domaineffect.NewRecord(id, string(lease.JobID), name, key, irreversible, now)
	if err != nil {
		return domaineffect.Record{}, err
	}
	return s.store.BeginEffect(ctx, lease, now, record)
}

func (s *Service) Confirm(ctx context.Context, lease ports.Lease, record domaineffect.Record, policy domaineffect.ConfirmationPolicy, status string) (domaineffect.Record, error) {
	if s == nil || s.store == nil || s.clock == nil {
		return record, ErrEffectStoreRequired
	}
	now := s.clock()
	if err := s.store.CheckLease(ctx, lease, now); err != nil {
		return record, err
	}
	updated, err := record.Confirm(policy, status)
	if err != nil {
		return record, err
	}
	if updated.State == record.State {
		return updated, nil
	}
	if err := s.store.ConfirmEffect(ctx, lease, now, updated); err != nil {
		return record, err
	}
	return updated, nil
}

// MarkUncertain is authored by RhinoQ itself when an execution dies with an
// effect still open, so it carries no lease: there is none left to present.
func (s *Service) MarkUncertain(ctx context.Context, record domaineffect.Record) (domaineffect.Record, error) {
	if s == nil || s.store == nil {
		return record, ErrEffectStoreRequired
	}
	updated, err := record.MarkUncertain()
	if err != nil {
		return record, err
	}
	if err := s.store.SaveEffect(ctx, updated); err != nil {
		return record, err
	}
	return updated, nil
}
