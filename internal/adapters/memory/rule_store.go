package memory

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/madebyduy/RhinoQ/internal/domain/rule"
	"github.com/madebyduy/RhinoQ/internal/ports"
)

var _ ports.RuleStore = (*RuleStore)(nil)

type RuleStore struct {
	mu           sync.RWMutex
	records      map[string]map[int]rule.Record
	explanations map[string]map[int]rule.Explanation
	schedules    map[string]memoryRuleSchedule
}

type memoryRuleSchedule struct {
	cursor, owner string
	epoch         int64
	nextRunAt     time.Time
	expiresAt     time.Time
}

func NewRuleStore() *RuleStore {
	return &RuleStore{
		records:      make(map[string]map[int]rule.Record),
		explanations: make(map[string]map[int]rule.Explanation),
		schedules:    make(map[string]memoryRuleSchedule),
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

func (s *RuleStore) GetRuleVersion(
	_ context.Context, id string, version int,
) (rule.Record, bool, error) {
	if id == "" || version < 1 {
		return rule.Record{}, false, rule.ErrInvalidRule
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	record, found := s.records[id][version]
	return record, found, nil
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
					(query.SubjectType == "" || record.SubjectType == query.SubjectType) &&
					ruleStatusMatches(record.Status, query.Statuses) {
					records = append(records, record)
				}
			}
			continue
		}
		record, found, _ := latestRule(versions)
		if !found || (query.Scope != "" && record.Scope != query.Scope) ||
			(query.SubjectType != "" && record.SubjectType != query.SubjectType) {
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
			if number != version && existing.Status == rule.Enabled {
				existing.Status = rule.Disabled
				existing.UpdatedAt = at
				versions[number] = existing
			}
		}
	}
	record.Status = status
	record.UpdatedAt = at
	versions[version] = record
	key := scheduleKey(id, version)
	schedule := s.schedules[key]
	if status == rule.Enabled && record.Scope == rule.TableScope {
		schedule.nextRunAt = at
		s.schedules[key] = schedule
	}
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

func scheduleKey(id string, version int) string {
	return id + ":" + fmt.Sprint(version)
}

func (s *RuleStore) ClaimDueRules(
	_ context.Context, owner string, now time.Time, leaseFor time.Duration, limit int,
) ([]rule.ScheduleLease, error) {
	if owner == "" || now.IsZero() || leaseFor <= 0 || limit <= 0 || limit > 100 {
		return nil, rule.ErrInvalidRule
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	candidates := make([]rule.Record, 0)
	for _, versions := range s.records {
		for _, record := range versions {
			if record.Scope != rule.TableScope || record.Status != rule.Enabled {
				continue
			}
			state := s.schedules[scheduleKey(record.ID, record.Version)]
			if (state.nextRunAt.IsZero() || !state.nextRunAt.After(now)) &&
				(state.expiresAt.IsZero() || !state.expiresAt.After(now)) {
				candidates = append(candidates, record)
			}
		}
	}
	sort.Slice(candidates, func(i, j int) bool {
		return candidates[i].ID < candidates[j].ID
	})
	if len(candidates) > limit {
		candidates = candidates[:limit]
	}
	leases := make([]rule.ScheduleLease, 0, len(candidates))
	for _, record := range candidates {
		key := scheduleKey(record.ID, record.Version)
		state := s.schedules[key]
		state.owner = owner
		state.epoch++
		state.expiresAt = now.Add(leaseFor)
		s.schedules[key] = state
		leases = append(leases, rule.ScheduleLease{
			RuleID: record.ID, Version: record.Version, Owner: owner,
			Epoch: state.epoch, Cursor: state.cursor, Every: record.Every,
			ClaimedAt: now, ExpiresAt: state.expiresAt,
		})
	}
	return leases, nil
}

func (s *RuleStore) AdvanceRuleCursor(
	_ context.Context, lease rule.ScheduleLease, cursor string,
) error {
	if strings.TrimSpace(cursor) == "" {
		return rule.ErrInvalidRule
	}
	return s.updateSchedule(lease, func(state *memoryRuleSchedule) {
		state.cursor, state.nextRunAt = cursor, lease.ClaimedAt
		state.owner, state.expiresAt = "", time.Time{}
	})
}

func (s *RuleStore) CompleteRuleRun(
	_ context.Context, lease rule.ScheduleLease,
) error {
	return s.updateSchedule(lease, func(state *memoryRuleSchedule) {
		state.cursor, state.nextRunAt = "", lease.ClaimedAt.Add(lease.Every)
		state.owner, state.expiresAt = "", time.Time{}
	})
}

func (s *RuleStore) FailRuleRun(
	_ context.Context, lease rule.ScheduleLease, retryAfter time.Duration, _ string,
) error {
	if retryAfter <= 0 {
		return rule.ErrInvalidRule
	}
	return s.updateSchedule(lease, func(state *memoryRuleSchedule) {
		state.nextRunAt = lease.ClaimedAt.Add(retryAfter)
		state.owner, state.expiresAt = "", time.Time{}
	})
}

func (s *RuleStore) updateSchedule(
	lease rule.ScheduleLease, update func(*memoryRuleSchedule),
) error {
	if err := lease.Validate(); err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	key := scheduleKey(lease.RuleID, lease.Version)
	state, found := s.schedules[key]
	if !found || state.owner != lease.Owner || state.epoch != lease.Epoch {
		return rule.ErrScheduleLeaseLost
	}
	update(&state)
	s.schedules[key] = state
	return nil
}
