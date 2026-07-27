package memory

import (
	"context"
	"errors"
	"sync"

	"github.com/rhinoq/rhinoq/internal/domain/outcome"
)

type OutcomeStore struct {
	mu      sync.RWMutex
	records map[string]outcome.Record
}

func NewOutcomeStore() *OutcomeStore {
	return &OutcomeStore{records: make(map[string]outcome.Record)}
}

func (s *OutcomeStore) SaveOutcome(_ context.Context, record outcome.Record) error {
	if record.ID == "" {
		return errors.New("outcome id is required")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.records[record.ID] = record
	return nil
}

func (s *OutcomeStore) GetOutcome(_ context.Context, id string) (outcome.Record, bool, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	record, ok := s.records[id]
	return record, ok, nil
}
