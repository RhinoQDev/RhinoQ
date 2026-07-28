package memory

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"sync"
	"time"

	"github.com/madebyduy/RhinoQ/internal/domain/effect"
	"github.com/madebyduy/RhinoQ/internal/domain/job"
	"github.com/madebyduy/RhinoQ/internal/domain/outcome"
	"github.com/madebyduy/RhinoQ/internal/domain/recovery"
)

type RecoveryStore struct {
	mu       sync.Mutex
	nextID   uint64
	jobs     *JobStore
	effects  *EffectStore
	outcomes *OutcomeStore
	audits   map[job.ID][]recovery.AuditRecord
}

func NewRecoveryStore(jobs *JobStore, effects *EffectStore, outcomes *OutcomeStore) (*RecoveryStore, error) {
	if jobs == nil || effects == nil || outcomes == nil {
		return nil, errors.New("job, effect and outcome stores are required")
	}
	return &RecoveryStore{
		jobs: jobs, effects: effects, outcomes: outcomes,
		audits: make(map[job.ID][]recovery.AuditRecord),
	}, nil
}

func (s *RecoveryStore) ListAttention(_ context.Context, query recovery.AttentionQuery) ([]recovery.AttentionItem, error) {
	if err := recovery.ValidateAttentionQuery(query); err != nil {
		return nil, err
	}
	s.jobs.mu.RLock()
	s.effects.mu.RLock()
	s.outcomes.mu.RLock()
	defer s.outcomes.mu.RUnlock()
	defer s.effects.mu.RUnlock()
	defer s.jobs.mu.RUnlock()

	items := make([]recovery.AttentionItem, 0)
	for _, record := range s.jobs.jobs {
		if query.Queue != "" && record.Name != query.Queue {
			continue
		}
		switch record.State {
		case job.Dead:
			items = append(items, recovery.AttentionItem{
				Kind: recovery.DeadJob, JobID: record.ID, Queue: record.Name,
				JobState: record.State, Reason: "job exhausted its execution policy", ObservedAt: record.CreatedAt,
			})
		case job.Blocked:
			reason := "execution requires an operator decision"
			if record.BlockedReason == job.BlockedPoisonJob {
				reason = "job repeatedly took its worker down and was parked"
			}
			items = append(items, recovery.AttentionItem{
				Kind: recovery.ExecutionBlocked, JobID: record.ID, Queue: record.Name,
				JobState: record.State, Reason: reason, ObservedAt: record.CreatedAt,
			})
		}
	}
	for _, record := range s.effects.effects {
		if record.State != effect.Uncertain {
			continue
		}
		jobRecord, ok := s.jobs.jobs[job.ID(record.JobID)]
		if !ok || (query.Queue != "" && jobRecord.Name != query.Queue) {
			continue
		}
		items = append(items, recovery.AttentionItem{
			Kind: recovery.EffectUncertain, JobID: jobRecord.ID, Queue: jobRecord.Name,
			JobState: jobRecord.State, ReferenceID: string(record.ID),
			Reason: "external effect may have happened", ObservedAt: record.CreatedAt,
		})
	}
	for _, record := range s.outcomes.records {
		if record.State != outcome.Mismatch && record.State != outcome.Unverifiable {
			continue
		}
		jobRecord, ok := s.jobs.jobs[job.ID(record.JobID)]
		if !ok || (query.Queue != "" && jobRecord.Name != query.Queue) {
			continue
		}
		reason := record.Reason
		if reason == "" {
			reason = "declared business outcome was not achieved"
		}
		items = append(items, recovery.AttentionItem{
			Kind: recovery.OutcomeMismatch, JobID: jobRecord.ID, Queue: jobRecord.Name,
			JobState: jobRecord.State, ReferenceID: record.ID,
			Reason: reason, ObservedAt: record.UpdatedAt,
		})
	}
	sort.Slice(items, func(i, j int) bool {
		if items[i].ObservedAt.Equal(items[j].ObservedAt) {
			if items[i].JobID == items[j].JobID {
				return items[i].Kind < items[j].Kind
			}
			return items[i].JobID > items[j].JobID
		}
		return items[i].ObservedAt.After(items[j].ObservedAt)
	})
	if query.Offset >= len(items) {
		return []recovery.AttentionItem{}, nil
	}
	end := query.Offset + query.Limit
	if end > len(items) {
		end = len(items)
	}
	return items[query.Offset:end], nil
}

func (s *RecoveryStore) Replay(_ context.Context, request recovery.ReplayRequest) (job.Record, recovery.AuditRecord, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.jobs.mu.Lock()
	defer s.jobs.mu.Unlock()
	s.effects.mu.RLock()
	defer s.effects.mu.RUnlock()

	record, ok := s.jobs.jobs[request.JobID]
	if !ok {
		return job.Record{}, recovery.AuditRecord{}, errors.New("job not found")
	}
	effects := make([]effect.Record, 0)
	for _, item := range s.effects.effects {
		if item.JobID == request.JobID.String() {
			effects = append(effects, item)
		}
	}
	if err := recovery.ValidateReplay(record, effects, request); err != nil {
		return job.Record{}, recovery.AuditRecord{}, err
	}

	s.nextID++
	audit := recovery.AuditRecord{
		ID: fmt.Sprintf("audit_%06d", s.nextID), JobID: record.ID,
		Action: "job_replayed", Actor: request.Actor, Reason: request.Reason,
		OccurredAt: request.RequestedAt,
	}
	history := s.audits[record.ID]
	if len(history) > 0 {
		audit.PrevHash = history[len(history)-1].RowHash
	}
	audit.RowHash = recovery.HashAudit(audit.PrevHash, audit)

	// A replayed job starts its crash budget again: an operator who decided the
	// payload is safe should not have it parked again by the previous crashes.
	record.State = job.Pending
	record.NotBefore = request.RequestedAt
	record.LeaseOwner = ""
	record.LeaseUntil = time.Time{}
	record.CancelRequested = false
	record.BlockedReason = ""
	record.CrashCount = 0
	s.jobs.jobs[record.ID] = record
	s.audits[record.ID] = append(history, audit)
	return cloneRecord(record), audit, nil
}

func (s *RecoveryStore) ListAudit(_ context.Context, jobID job.ID, offset, limit int) ([]recovery.AuditRecord, error) {
	if jobID == "" || offset < 0 || limit <= 0 || limit > 1000 {
		return nil, errors.New("job id, non-negative offset and limit between 1 and 1000 are required")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	history := s.audits[jobID]
	if offset >= len(history) {
		return []recovery.AuditRecord{}, nil
	}
	end := offset + limit
	if end > len(history) {
		end = len(history)
	}
	result := make([]recovery.AuditRecord, end-offset)
	for index := offset; index < end; index++ {
		result[index-offset] = history[len(history)-1-index]
	}
	return result, nil
}
