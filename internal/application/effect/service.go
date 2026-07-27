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

func (s *Service) Begin(ctx context.Context, id domaineffect.ID, jobID, name, key string, irreversible bool) (domaineffect.Record, error) {
	if s == nil || s.store == nil || s.clock == nil {
		return domaineffect.Record{}, ErrEffectStoreRequired
	}
	record, err := domaineffect.NewRecord(id, jobID, name, key, irreversible, s.clock())
	if err != nil {
		return domaineffect.Record{}, err
	}
	return s.store.BeginEffect(ctx, record)
}

func (s *Service) Confirm(ctx context.Context, record domaineffect.Record, policy domaineffect.ConfirmationPolicy, status string) (domaineffect.Record, error) {
	updated, err := record.Confirm(policy, status)
	if err != nil {
		return record, err
	}
	if updated.State == record.State {
		return updated, nil
	}
	if err := s.store.SaveEffect(ctx, updated); err != nil {
		return record, err
	}
	return updated, nil
}

func (s *Service) MarkUncertain(ctx context.Context, record domaineffect.Record) (domaineffect.Record, error) {
	updated, err := record.MarkUncertain()
	if err != nil {
		return record, err
	}
	if err := s.store.SaveEffect(ctx, updated); err != nil {
		return record, err
	}
	return updated, nil
}
