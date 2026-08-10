package memory

import (
	"context"
	"fmt"
	"sort"
	"sync"
	"time"

	"github.com/madebyduy/RhinoQ/internal/domain/provideroperation"
	"github.com/madebyduy/RhinoQ/internal/ports"
)

type ProviderOperationStore struct {
	mu       sync.RWMutex
	byID     map[provideroperation.ID]provideroperation.Record
	byKey    map[string]provideroperation.ID
	evidence map[provideroperation.ID][]provideroperation.Evidence
}

func (s *ProviderOperationStore) ListProviderOperations(_ context.Context, states []provideroperation.State, before time.Time, limit int) ([]provideroperation.Record, error) {
	if limit < 1 || limit > 500 || before.IsZero() {
		return nil, fmt.Errorf("provider operation query requires before and limit 1..500")
	}
	wanted := make(map[provideroperation.State]bool, len(states))
	for _, state := range states {
		wanted[state] = true
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	items := make([]provideroperation.Record, 0, limit)
	for _, record := range s.byID {
		if wanted[record.State] && !record.UpdatedAt.After(before) {
			items = append(items, record)
		}
	}
	sort.Slice(items, func(i, j int) bool {
		if items[i].UpdatedAt.Equal(items[j].UpdatedAt) {
			return items[i].ID < items[j].ID
		}
		return items[i].UpdatedAt.Before(items[j].UpdatedAt)
	})
	if len(items) > limit {
		items = items[:limit]
	}
	return items, nil
}

func (s *ProviderOperationStore) ListProviderOperationsByTask(_ context.Context, taskID string, limit int) ([]provideroperation.Record, error) {
	if taskID == "" || limit < 1 || limit > 500 {
		return nil, fmt.Errorf("provider operation task query requires task id and limit 1..500")
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	items := make([]provideroperation.Record, 0, limit)
	for _, record := range s.byID {
		if record.TaskID == taskID {
			items = append(items, record)
		}
	}
	sort.Slice(items, func(i, j int) bool {
		if items[i].CreatedAt.Equal(items[j].CreatedAt) {
			return items[i].ID < items[j].ID
		}
		return items[i].CreatedAt.Before(items[j].CreatedAt)
	})
	if len(items) > limit {
		items = items[:limit]
	}
	return items, nil
}

func NewProviderOperationStore() *ProviderOperationStore {
	return &ProviderOperationStore{byID: map[provideroperation.ID]provideroperation.Record{}, byKey: map[string]provideroperation.ID{}, evidence: map[provideroperation.ID][]provideroperation.Evidence{}}
}

func providerOperationKey(r provideroperation.Record) string {
	return r.Provider + "\x00" + r.Operation + "\x00" + r.IdempotencyKey
}

func (s *ProviderOperationStore) BeginProviderOperation(_ context.Context, record provideroperation.Record) (provideroperation.Record, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	key := providerOperationKey(record)
	if id, ok := s.byKey[key]; ok {
		return s.byID[id], nil
	}
	if _, ok := s.byID[record.ID]; ok {
		return provideroperation.Record{}, fmt.Errorf("%w: provider operation %s", ports.ErrAlreadyExists, record.ID)
	}
	s.byID[record.ID], s.byKey[key] = record, record.ID
	return record, nil
}
func (s *ProviderOperationStore) GetProviderOperation(_ context.Context, id provideroperation.ID) (provideroperation.Record, bool, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	record, ok := s.byID[id]
	return record, ok, nil
}
func (s *ProviderOperationStore) SaveProviderOperation(_ context.Context, record provideroperation.Record, expected int64, evidence *provideroperation.Evidence) (provideroperation.Record, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	current, ok := s.byID[record.ID]
	if !ok {
		return provideroperation.Record{}, ports.ErrProviderOperationNotFound
	}
	if current.Version != expected || record.Version != expected+1 {
		return provideroperation.Record{}, ports.ErrVersionConflict
	}
	s.byID[record.ID] = record
	if evidence != nil {
		entry := *evidence
		entry.Sequence = int64(len(s.evidence[record.ID]) + 1)
		s.evidence[record.ID] = append(s.evidence[record.ID], entry)
	}
	return record, nil
}

func (s *ProviderOperationStore) ListProviderOperationEvidence(_ context.Context, id provideroperation.ID) ([]provideroperation.Evidence, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if _, ok := s.byID[id]; !ok {
		return nil, ports.ErrProviderOperationNotFound
	}
	return append([]provideroperation.Evidence(nil), s.evidence[id]...), nil
}
