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

// countRuleOutcomes and deleteRuleOutcomes back the in-memory Rule delete.
// An Outcome is the canonical state for one Rule version and one subject, so
// it has no meaning once that version is gone.
func (s *SubjectOutcomeStore) countRuleOutcomes(ruleID string, version int) int {
	s.mu.RLock()
	defer s.mu.RUnlock()
	count := 0
	for _, record := range s.records {
		if outcomeBelongsToRule(record.Key, ruleID, version) {
			count++
		}
	}
	return count
}

func (s *SubjectOutcomeStore) deleteRuleOutcomes(ruleID string, version int) int {
	s.mu.Lock()
	defer s.mu.Unlock()
	removed := 0
	for key, record := range s.records {
		if outcomeBelongsToRule(record.Key, ruleID, version) {
			delete(s.records, key)
			removed++
		}
	}
	return removed
}

func outcomeBelongsToRule(key subjectoutcome.Key, ruleID string, version int) bool {
	return key.RuleID == ruleID && (version == 0 || key.RuleVersion == version)
}
