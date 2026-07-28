package memory

import (
	"context"
	"errors"
	"sort"
	"sync"

	"github.com/madebyduy/RhinoQ/internal/domain/outcome"
	"github.com/madebyduy/RhinoQ/internal/ports"
)

var _ ports.OutcomeReader = (*OutcomeStore)(nil)

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

func (s *OutcomeStore) ListOutcomes(
	_ context.Context,
	jobID string,
	offset, limit int,
) ([]outcome.Record, error) {
	if jobID == "" || offset < 0 || limit <= 0 || limit > 1000 {
		return nil, errors.New("job id, non-negative offset and limit between 1 and 1000 are required")
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	records := make([]outcome.Record, 0, len(s.records))
	for _, record := range s.records {
		if record.JobID == jobID {
			records = append(records, record)
		}
	}
	sort.Slice(records, func(i, j int) bool {
		if records[i].ContractVersion == records[j].ContractVersion {
			return records[i].UpdatedAt.Before(records[j].UpdatedAt)
		}
		return records[i].ContractVersion < records[j].ContractVersion
	})
	if offset >= len(records) {
		return []outcome.Record{}, nil
	}
	end := min(offset+limit, len(records))
	return append([]outcome.Record(nil), records[offset:end]...), nil
}
