package memory

import (
	"context"
	"errors"
	"sync"
	"time"

	"github.com/rhinoq/rhinoq/internal/domain/effect"
	"github.com/rhinoq/rhinoq/internal/ports"
)

var ErrEffectConflict = errors.New("effect already exists with different identity")

var _ ports.EffectStore = (*EffectStore)(nil)

type EffectStore struct {
	mu      sync.RWMutex
	fence   ports.LeaseFence
	effects map[string]effect.Record
}

// NewEffectStore builds an in-memory effect ledger. The fence is mandatory:
// opening an effect is the last point at which RhinoQ can stop a worker that
// lost its lease from spending real money twice.
func NewEffectStore(fence ports.LeaseFence) (*EffectStore, error) {
	if fence == nil {
		return nil, errors.New("effect store requires a lease fence")
	}
	return &EffectStore{fence: fence, effects: make(map[string]effect.Record)}, nil
}

func (s *EffectStore) CheckLease(ctx context.Context, lease ports.Lease, now time.Time) error {
	return s.fence.CheckLease(ctx, lease, now)
}

func (s *EffectStore) BeginEffect(ctx context.Context, lease ports.Lease, now time.Time, record effect.Record) (effect.Record, error) {
	if err := s.fence.CheckLease(ctx, lease, now); err != nil {
		return effect.Record{}, err
	}
	if string(lease.JobID) != record.JobID {
		return effect.Record{}, ports.LeaseLost(lease, "the effect belongs to job "+record.JobID)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	key := effectKey(record.JobID, record.Name, record.IdempotencyKey)
	if existing, ok := s.effects[key]; ok {
		if existing.ID != record.ID {
			return effect.Record{}, ErrEffectConflict
		}
		return existing, nil
	}
	record.LeaseEpoch = lease.Epoch
	s.effects[key] = record
	return record, nil
}

func (s *EffectStore) GetEffect(_ context.Context, jobID, name, idempotencyKey string) (effect.Record, bool, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	record, ok := s.effects[effectKey(jobID, name, idempotencyKey)]
	return record, ok, nil
}

func (s *EffectStore) ConfirmEffect(ctx context.Context, lease ports.Lease, now time.Time, record effect.Record) error {
	if err := s.fence.CheckLease(ctx, lease, now); err != nil {
		return err
	}
	if string(lease.JobID) != record.JobID {
		return ports.LeaseLost(lease, "the effect belongs to job "+record.JobID)
	}
	return s.SaveEffect(ctx, record)
}

func (s *EffectStore) SaveEffect(_ context.Context, record effect.Record) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	key := effectKey(record.JobID, record.Name, record.IdempotencyKey)
	existing, ok := s.effects[key]
	if !ok {
		return errors.New("effect does not exist")
	}
	record.LeaseEpoch = existing.LeaseEpoch
	s.effects[key] = record
	return nil
}

func (s *EffectStore) MarkPendingUncertain(_ context.Context, expired []ports.ExpiredLease) (int, error) {
	if len(expired) == 0 {
		return 0, nil
	}
	epochs := make(map[string]int64, len(expired))
	for _, item := range expired {
		if current, ok := epochs[string(item.JobID)]; !ok || item.Epoch > current {
			epochs[string(item.JobID)] = item.Epoch
		}
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	downgraded := 0
	for key, record := range s.effects {
		epoch, ok := epochs[record.JobID]
		if !ok || record.State != effect.Pending || record.LeaseEpoch > epoch {
			continue
		}
		updated, err := record.MarkUncertain()
		if err != nil {
			return downgraded, err
		}
		s.effects[key] = updated
		downgraded++
	}
	return downgraded, nil
}

func effectKey(jobID, name, idempotencyKey string) string {
	return jobID + "\x00" + name + "\x00" + idempotencyKey
}
