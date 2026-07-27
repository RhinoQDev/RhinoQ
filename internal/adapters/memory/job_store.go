package memory

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"sync"
	"time"

	"github.com/rhinoq/rhinoq/internal/domain/job"
	"github.com/rhinoq/rhinoq/internal/ports"
)

type JobStore struct {
	mu         sync.RWMutex
	nextID     uint64
	nextLease  uint64
	jobs       map[job.ID]job.Record
	byIdem     map[string]job.ID
	paused     map[string]bool
	rateLimits map[string]queueRateLimitState
	clock      func() time.Time
}

type queueRateLimitState struct {
	limit         ports.QueueRateLimit
	windowStarted time.Time
	count         int
}

func NewJobStore() *JobStore {
	return NewJobStoreWithClock(time.Now)
}

func NewJobStoreWithClock(clock func() time.Time) *JobStore {
	return &JobStore{
		jobs:       make(map[job.ID]job.Record),
		byIdem:     make(map[string]job.ID),
		paused:     make(map[string]bool),
		rateLimits: make(map[string]queueRateLimitState),
		clock:      clock,
	}
}

func (s *JobStore) Enqueue(ctx context.Context, input ports.EnqueueInput) (ports.JobID, error) {
	select {
	case <-ctx.Done():
		return "", ctx.Err()
	default:
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	if input.IdempotencyKey != "" {
		if id, exists := s.byIdem[idempotencyScope(input)]; exists {
			return id, nil
		}
	}

	s.nextID++
	id := job.ID(fmt.Sprintf("job_%06d", s.nextID))
	record, err := job.NewRecord(id, input.Name, input.Payload, s.clock(), input.NotBefore)
	if err != nil {
		return "", err
	}
	record.IdempotencyKey = input.IdempotencyKey
	record.CorrelationID = input.CorrelationID
	s.jobs[id] = record
	if input.IdempotencyKey != "" {
		s.byIdem[idempotencyScope(input)] = id
	}
	return id, nil
}

func (s *JobStore) Get(_ context.Context, id ports.JobID) (job.Record, bool, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	record, ok := s.jobs[id]
	if !ok {
		return job.Record{}, false, nil
	}
	record.Payload = append([]byte(nil), record.Payload...)
	return record, true, nil
}

func (s *JobStore) ListJobs(_ context.Context, input ports.ListJobsInput) ([]job.Record, error) {
	if input.Offset < 0 || input.Limit <= 0 || input.Limit > 1000 {
		return nil, errors.New("offset must be non-negative and limit must be between 1 and 1000")
	}
	states := make(map[job.State]bool, len(input.States))
	for _, state := range input.States {
		if !state.Valid() {
			return nil, errors.New("invalid job state filter")
		}
		states[state] = true
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	records := make([]job.Record, 0, len(s.jobs))
	for _, record := range s.jobs {
		if input.Name != "" && record.Name != input.Name {
			continue
		}
		if len(states) > 0 && !states[record.State] {
			continue
		}
		records = append(records, cloneRecord(record))
	}
	sort.Slice(records, func(i, j int) bool {
		if records[i].CreatedAt.Equal(records[j].CreatedAt) {
			return records[i].ID > records[j].ID
		}
		return records[i].CreatedAt.After(records[j].CreatedAt)
	})
	if input.Offset >= len(records) {
		return []job.Record{}, nil
	}
	end := input.Offset + input.Limit
	if end > len(records) {
		end = len(records)
	}
	return records[input.Offset:end], nil
}

func (s *JobStore) JobCounts(_ context.Context, name string) (map[job.State]int64, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	counts := make(map[job.State]int64)
	for _, record := range s.jobs {
		if name == "" || record.Name == name {
			counts[record.State]++
		}
	}
	return counts, nil
}

func (s *JobStore) Claim(ctx context.Context, input ports.ClaimInput) ([]job.Record, error) {
	select {
	case <-ctx.Done():
		return nil, ctx.Err()
	default:
	}
	if input.Limit <= 0 || input.LeaseDuration <= 0 || input.Now.IsZero() {
		return nil, errors.New("invalid claim input")
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	ids := make([]job.ID, 0, len(s.jobs))
	for id := range s.jobs {
		ids = append(ids, id)
	}
	sort.Slice(ids, func(i, j int) bool {
		left, right := s.jobs[ids[i]], s.jobs[ids[j]]
		if left.CreatedAt.Equal(right.CreatedAt) {
			return left.ID < right.ID
		}
		return left.CreatedAt.Before(right.CreatedAt)
	})

	claimed := make([]job.Record, 0, input.Limit)
	for _, id := range ids {
		record := s.jobs[id]
		if len(claimed) == input.Limit {
			break
		}
		if !claimable(record, input.Now) {
			continue
		}
		if s.paused[record.Name] {
			continue
		}
		if !s.allowClaim(record.Name, input.Now) {
			continue
		}
		s.nextLease++
		record.State = job.Leased
		record.Attempts++
		record.LeaseID = fmt.Sprintf("lease_%06d", s.nextLease)
		record.LeaseUntil = input.Now.Add(input.LeaseDuration)
		s.jobs[id] = record
		claimed = append(claimed, cloneRecord(record))
	}
	return claimed, nil
}

func (s *JobStore) SetQueueRateLimit(_ context.Context, name string, limit ports.QueueRateLimit) error {
	if name == "" || limit.Max <= 0 || limit.Window < time.Millisecond {
		return errors.New("queue name, positive max and a window of at least one millisecond are required")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.rateLimits[name] = queueRateLimitState{limit: limit}
	return nil
}

func (s *JobStore) RemoveQueueRateLimit(_ context.Context, name string) error {
	if name == "" {
		return errors.New("queue name is required")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.rateLimits, name)
	return nil
}

func (s *JobStore) QueueRateLimitTTL(_ context.Context, name string, now time.Time) (time.Duration, error) {
	if name == "" || now.IsZero() {
		return 0, errors.New("queue name and current time are required")
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	state, ok := s.rateLimits[name]
	if !ok || state.count < state.limit.Max || state.windowStarted.IsZero() {
		return 0, nil
	}
	ttl := state.windowStarted.Add(state.limit.Window).Sub(now)
	if ttl < 0 {
		return 0, nil
	}
	return ttl, nil
}

func (s *JobStore) PauseQueue(_ context.Context, name string) error {
	if name == "" {
		return errors.New("queue name is required")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.paused[name] = true
	return nil
}

func (s *JobStore) ResumeQueue(_ context.Context, name string) error {
	if name == "" {
		return errors.New("queue name is required")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.paused, name)
	return nil
}

func (s *JobStore) RenewLease(_ context.Context, lease ports.Lease, now time.Time, extension time.Duration) error {
	if lease.JobID == "" || lease.LeaseID == "" || extension <= 0 || now.IsZero() {
		return errors.New("invalid lease renewal")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	record, ok := s.jobs[job.ID(lease.JobID)]
	if !ok || record.State != job.Leased || record.LeaseID != lease.LeaseID || !record.LeaseUntil.After(now) {
		return errors.New("lease is not authoritative")
	}
	record.LeaseUntil = now.Add(extension)
	s.jobs[job.ID(lease.JobID)] = record
	return nil
}

func (s *JobStore) Complete(_ context.Context, lease ports.Lease, now time.Time) error {
	if lease.JobID == "" || lease.LeaseID == "" || now.IsZero() {
		return errors.New("invalid completion lease")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	record, ok := s.jobs[job.ID(lease.JobID)]
	if !ok || record.State != job.Leased || record.LeaseID != lease.LeaseID || !record.LeaseUntil.After(now) {
		return errors.New("lease is not authoritative")
	}
	record.State = job.Succeeded
	record.LeaseID = ""
	record.LeaseUntil = time.Time{}
	s.jobs[job.ID(lease.JobID)] = record
	return nil
}

func (s *JobStore) Fail(_ context.Context, lease ports.Lease, now time.Time, transition ports.FailureTransition) error {
	if lease.JobID == "" || lease.LeaseID == "" || now.IsZero() {
		return errors.New("invalid failure lease")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	record, ok := s.jobs[job.ID(lease.JobID)]
	if !ok || record.State != job.Leased || record.LeaseID != lease.LeaseID || !record.LeaseUntil.After(now) {
		return errors.New("lease is not authoritative")
	}
	if transition.State != job.RetryWait && transition.State != job.Dead && transition.State != job.Blocked && transition.State != job.Cancelled {
		return errors.New("invalid failure state")
	}
	record.State = transition.State
	record.NotBefore = transition.NotBefore
	record.LeaseID = ""
	record.LeaseUntil = time.Time{}
	s.jobs[job.ID(lease.JobID)] = record
	return nil
}

func (s *JobStore) RequestCancel(_ context.Context, id ports.JobID) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	record, ok := s.jobs[job.ID(id)]
	if !ok {
		return errors.New("job not found")
	}
	switch record.State {
	case job.Pending, job.RetryWait, job.Blocked:
		record.State = job.Cancelled
		record.LeaseID = ""
		record.LeaseUntil = time.Time{}
	case job.Leased:
		record.CancelRequested = true
	case job.Succeeded, job.Dead, job.Cancelled:
		return nil
	default:
		return errors.New("job cannot be cancelled in current state")
	}
	s.jobs[job.ID(id)] = record
	return nil
}

func (s *JobStore) IsCancelRequested(_ context.Context, id ports.JobID) (bool, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	record, ok := s.jobs[job.ID(id)]
	if !ok {
		return false, errors.New("job not found")
	}
	return record.CancelRequested, nil
}

func (s *JobStore) RequeueExpired(_ context.Context, now time.Time) (int, error) {
	if now.IsZero() {
		return 0, errors.New("reaper time is required")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	count := 0
	for id, record := range s.jobs {
		if record.State != job.Leased || record.LeaseUntil.IsZero() || record.LeaseUntil.After(now) {
			continue
		}
		record.State = job.RetryWait
		record.NotBefore = now
		record.LeaseID = ""
		record.LeaseUntil = time.Time{}
		s.jobs[id] = record
		count++
	}
	return count, nil
}

func claimable(record job.Record, now time.Time) bool {
	return (record.State == job.Pending || record.State == job.RetryWait) && !record.NotBefore.After(now)
}

func (s *JobStore) allowClaim(name string, now time.Time) bool {
	state, ok := s.rateLimits[name]
	if !ok {
		return true
	}
	if state.windowStarted.IsZero() || !now.Before(state.windowStarted.Add(state.limit.Window)) {
		state.windowStarted = now
		state.count = 1
		s.rateLimits[name] = state
		return true
	}
	if state.count >= state.limit.Max {
		return false
	}
	state.count++
	s.rateLimits[name] = state
	return true
}

func cloneRecord(record job.Record) job.Record {
	record.Payload = append([]byte(nil), record.Payload...)
	return record
}

func idempotencyScope(input ports.EnqueueInput) string {
	return input.Name + "\x00" + input.IdempotencyKey
}
