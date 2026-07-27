package memory

import (
	"context"
	"errors"
	"sync"

	"github.com/rhinoq/rhinoq/internal/domain/effect"
)

var ErrEffectConflict = errors.New("effect already exists with different identity")

type EffectStore struct {
	mu      sync.RWMutex
	effects map[string]effect.Record
}

func NewEffectStore() *EffectStore {
	return &EffectStore{effects: make(map[string]effect.Record)}
}

func (s *EffectStore) BeginEffect(_ context.Context, record effect.Record) (effect.Record, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	key := effectKey(record.JobID, record.Name, record.IdempotencyKey)
	if existing, ok := s.effects[key]; ok {
		if existing.ID != record.ID {
			return effect.Record{}, ErrEffectConflict
		}
		return existing, nil
	}
	s.effects[key] = record
	return record, nil
}

func (s *EffectStore) GetEffect(_ context.Context, jobID, name, idempotencyKey string) (effect.Record, bool, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	record, ok := s.effects[effectKey(jobID, name, idempotencyKey)]
	return record, ok, nil
}

func (s *EffectStore) SaveEffect(_ context.Context, record effect.Record) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	key := effectKey(record.JobID, record.Name, record.IdempotencyKey)
	if _, ok := s.effects[key]; !ok {
		return errors.New("effect does not exist")
	}
	s.effects[key] = record
	return nil
}

func effectKey(jobID, name, idempotencyKey string) string {
	return jobID + "\x00" + name + "\x00" + idempotencyKey
}
