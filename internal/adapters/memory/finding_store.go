package memory

import (
	"context"
	"errors"
	"sort"
	"sync"

	"github.com/rhinoq/rhinoq/internal/domain/finding"
	"github.com/rhinoq/rhinoq/internal/ports"
)

var _ ports.FindingStore = (*FindingStore)(nil)

type FindingStore struct {
	mu      sync.RWMutex
	records map[string]finding.Record
	events  map[string][]finding.Event
	nextSeq int64
}

func NewFindingStore() *FindingStore {
	return &FindingStore{
		records: make(map[string]finding.Record),
		events:  make(map[string][]finding.Event),
	}
}

func (s *FindingStore) ObserveFinding(
	_ context.Context,
	observation finding.Observation,
) (finding.Record, error) {
	if err := observation.Validate(); err != nil {
		return finding.Record{}, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()

	key := observation.Key.String()
	existing, found := s.records[key]
	updated, err := finding.Apply(existing, found, observation)
	if err != nil {
		return finding.Record{}, err
	}
	s.records[key] = updated
	s.nextSeq++
	s.events[key] = append(s.events[key], finding.Event{
		Sequence: s.nextSeq, Key: observation.Key, Kind: finding.EventObserved,
		FromStatus: existing.Status, ToStatus: updated.Status,
		Evidence: observation.Evidence, OccurredAt: observation.ObservedAt,
	})
	return updated, nil
}

func (s *FindingStore) TransitionFinding(
	_ context.Context,
	key finding.Key,
	transition finding.Transition,
) (finding.Record, error) {
	if err := key.Validate(); err != nil {
		return finding.Record{}, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()

	mapKey := key.String()
	existing, found := s.records[mapKey]
	if !found {
		return finding.Record{}, ports.ErrFindingNotFound
	}
	updated, err := finding.ApplyTransition(existing, transition)
	if err != nil {
		return finding.Record{}, err
	}
	s.records[mapKey] = updated
	s.nextSeq++
	s.events[mapKey] = append(s.events[mapKey], finding.Event{
		Sequence: s.nextSeq, Key: key, Kind: finding.EventTransition,
		FromStatus: existing.Status, ToStatus: updated.Status,
		Actor: transition.Actor, Reason: transition.Reason,
		Until: transition.Until, OccurredAt: transition.At,
	})
	return updated, nil
}

func (s *FindingStore) GetFinding(
	_ context.Context,
	key finding.Key,
) (finding.Record, bool, error) {
	if err := key.Validate(); err != nil {
		return finding.Record{}, false, err
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	record, found := s.records[key.String()]
	return record, found, nil
}

func (s *FindingStore) ListFindings(
	_ context.Context,
	query finding.Query,
) ([]finding.Record, error) {
	if err := query.Validate(); err != nil {
		return nil, err
	}
	s.mu.RLock()
	defer s.mu.RUnlock()

	result := make([]finding.Record, 0, len(s.records))
	for _, record := range s.records {
		if query.Matches(record) {
			result = append(result, record)
		}
	}
	sort.Slice(result, func(i, j int) bool {
		if result[i].UpdatedAt.Equal(result[j].UpdatedAt) {
			return result[i].Key.String() < result[j].Key.String()
		}
		return result[i].UpdatedAt.After(result[j].UpdatedAt)
	})
	if query.Offset >= len(result) {
		return []finding.Record{}, nil
	}
	end := query.Offset + query.Limit
	if end > len(result) {
		end = len(result)
	}
	return append([]finding.Record(nil), result[query.Offset:end]...), nil
}

func (s *FindingStore) ListFindingEvents(
	_ context.Context,
	key finding.Key,
	offset, limit int,
) ([]finding.Event, error) {
	if err := key.Validate(); err != nil {
		return nil, err
	}
	if offset < 0 || limit <= 0 || limit > 1000 {
		return nil, errors.New("event offset must be non-negative and limit must be between 1 and 1000")
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	history := s.events[key.String()]
	if offset >= len(history) {
		return []finding.Event{}, nil
	}
	end := offset + limit
	if end > len(history) {
		end = len(history)
	}
	result := make([]finding.Event, 0, end-offset)
	for index := offset; index < end; index++ {
		result = append(result, history[len(history)-1-index])
	}
	return result, nil
}
