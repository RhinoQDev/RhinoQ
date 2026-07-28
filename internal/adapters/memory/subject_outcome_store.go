package memory

import (
	"context"
	"fmt"
	"sync"

	"github.com/madebyduy/RhinoQ/internal/domain/subjectoutcome"
)

type SubjectOutcomeStore struct {
	mu      sync.RWMutex
	records map[string]subjectoutcome.Record
}

func NewSubjectOutcomeStore() *SubjectOutcomeStore {
	return &SubjectOutcomeStore{records: make(map[string]subjectoutcome.Record)}
}

func subjectOutcomeKey(key subjectoutcome.Key) string {
	return fmt.Sprintf(
		"%s\x00%d\x00%s\x00%s",
		key.RuleID, key.RuleVersion, key.SubjectType, key.SubjectID,
	)
}

func (s *SubjectOutcomeStore) GetSubjectOutcome(
	_ context.Context,
	key subjectoutcome.Key,
) (subjectoutcome.Record, bool, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	record, found := s.records[subjectOutcomeKey(key)]
	return record, found, nil
}

func (s *SubjectOutcomeStore) SaveSubjectOutcome(
	_ context.Context,
	record subjectoutcome.Record,
) (bool, error) {
	if err := record.Key.Validate(); err != nil {
		return false, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	existing, found := s.records[subjectOutcomeKey(record.Key)]
	if found && existing.LastObservedAt.After(record.LastObservedAt) {
		return false, nil
	}
	s.records[subjectOutcomeKey(record.Key)] = record
	return true, nil
}
