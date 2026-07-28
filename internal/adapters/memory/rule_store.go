package memory

import (
	"context"
	"errors"
	"sort"
	"sync"
	"time"

	"github.com/rhinoq/rhinoq/internal/domain/rule"
	"github.com/rhinoq/rhinoq/internal/ports"
)

var _ ports.RuleStore = (*RuleStore)(nil)

type RuleStore struct {
	mu           sync.RWMutex
	records      map[string]map[int]rule.Record
	explanations map[string]map[int]rule.Explanation
}

func NewRuleStore() *RuleStore {
	return &RuleStore{
		records:      make(map[string]map[int]rule.Record),
		explanations: make(map[string]map[int]rule.Explanation),
	}
}

func (s *RuleStore) SaveRule(_ context.Context, record rule.Record) (rule.Record, error) {
	record = record.WithDefaults()
	if err := record.Validate(); err != nil {
		return rule.Record{}, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	versions := s.records[record.ID]
	if versions == nil {
		versions = make(map[int]rule.Record)
		s.records[record.ID] = versions
	}
	if _, exists := versions[record.Version]; exists {
		return rule.Record{}, errors.New("rule version already exists")
	}
	versions[record.Version] = record
	return record, nil
}

func (s *RuleStore) GetRule(_ context.Context, id string) (rule.Record, bool, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return latestRule(s.records[id])
}

func latestRule(versions map[int]rule.Record) (rule.Record, bool, error) {
	var latest rule.Record
	found := false
	for version, record := range versions {
		if !found || version > latest.Version {
			latest = record
			found = true
		}
	}
	return latest, found, nil
}

func (s *RuleStore) ListRules(_ context.Context, query rule.Query) ([]rule.Record, error) {
	if err := query.Validate(); err != nil {
		return nil, err
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	records := make([]rule.Record, 0, len(s.records))
	for _, versions := range s.records {
		if len(query.Statuses) > 0 {
			for _, record := range versions {
				if (query.Scope == "" || record.Scope == query.Scope) &&
					ruleStatusMatches(record.Status, query.Statuses) {
					records = append(records, record)
				}
			}
			continue
		}
		record, found, _ := latestRule(versions)
		if !found || (query.Scope != "" && record.Scope != query.Scope) {
			continue
		}
		records = append(records, record)
	}
	sort.Slice(records, func(i, j int) bool {
		if records[i].ID == records[j].ID {
			return records[i].Version > records[j].Version
		}
		return records[i].ID < records[j].ID
	})
	if query.Offset >= len(records) {
		return []rule.Record{}, nil
	}
	end := query.Offset + query.Limit
	if end > len(records) {
		end = len(records)
	}
	return append([]rule.Record(nil), records[query.Offset:end]...), nil
}

func ruleStatusMatches(status rule.Status, statuses []rule.Status) bool {
	if len(statuses) == 0 {
		return true
	}
	for _, expected := range statuses {
		if status == expected {
			return true
		}
	}
	return false
}

func (s *RuleStore) SetRuleStatus(
	_ context.Context,
	id string,
	version int,
	status rule.Status,
	at time.Time,
) (rule.Record, error) {
	if !status.Valid() || at.IsZero() {
		return rule.Record{}, rule.ErrInvalidRule
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	versions := s.records[id]
	record, found := versions[version]
	if !found {
		return rule.Record{}, ports.ErrRuleNotFound
	}
	if status == rule.Enabled {
		for number, existing := range versions {
			if existing.Status == rule.Enabled {
				existing.Status = rule.Disabled
				existing.UpdatedAt = at
				versions[number] = existing
			}
		}
	}
	record.Status = status
	record.UpdatedAt = at
	versions[version] = record
	return record, nil
}

func (s *RuleStore) SaveRuleExplanation(
	_ context.Context,
	id string,
	version int,
	explanation rule.Explanation,
) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, found := s.records[id][version]; !found {
		return ports.ErrRuleNotFound
	}
	versions := s.explanations[id]
	if versions == nil {
		versions = make(map[int]rule.Explanation)
		s.explanations[id] = versions
	}
	versions[version] = explanation
	return nil
}

func (s *RuleStore) GetRuleExplanation(
	_ context.Context,
	id string,
	version int,
) (rule.Explanation, bool, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	explanation, found := s.explanations[id][version]
	return explanation, found, nil
}
