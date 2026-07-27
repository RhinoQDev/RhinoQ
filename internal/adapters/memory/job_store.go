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

var ErrContextCancelled = errors.New("enqueue context cancelled")

type JobStore struct {
	mu        sync.RWMutex
	nextID    uint64
	nextLease uint64
	jobs      map[job.ID]job.Record
	byIdem    map[string]job.ID
	paused    map[string]bool
	clock     func() time.Time
}

func NewJobStore() *JobStore {
	return NewJobStoreWithClock(time.Now)
}

func NewJobStoreWithClock(clock func() time.Time) *JobStore {
	return &JobStore{
		jobs:   make(map[job.ID]job.Record),
		byIdem: make(map[string]job.ID),
		paused: make(map[string]bool),
		clock:  clock,
	}
}

func (s *JobStore) Enqueue(ctx context.Context, input ports.EnqueueInput) (ports.JobID, error) {
	select {
	case <-ctx.Done():
		return "", ErrContextCancelled
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

func (s *JobStore) Claim(ctx context.Context, input ports.ClaimInput) ([]job.Record, error) {
	select {
	case <-ctx.Done():
		return nil, ErrContextCancelled
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
	if transition.State != job.RetryWait && transition.State != job.Dead && transition.State != job.Blocked {
		return errors.New("invalid failure state")
	}
	record.State = transition.State
	record.NotBefore = transition.NotBefore
	record.LeaseID = ""
	record.LeaseUntil = time.Time{}
	s.jobs[job.ID(lease.JobID)] = record
	return nil
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

func cloneRecord(record job.Record) job.Record {
	record.Payload = append([]byte(nil), record.Payload...)
	return record
}

func idempotencyScope(input ports.EnqueueInput) string {
	return input.Name + "\x00" + input.IdempotencyKey
}
