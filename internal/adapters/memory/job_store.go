package memory

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"sync"
	"time"

	"github.com/rhinoq/rhinoq/internal/domain/admission"
	"github.com/rhinoq/rhinoq/internal/domain/attempt"
	"github.com/rhinoq/rhinoq/internal/domain/job"
	"github.com/rhinoq/rhinoq/internal/ports"
)

// JobStore implements the full job port; the assertion keeps a missing method
// a compile error rather than a runtime surprise.
var _ ports.JobStore = (*JobStore)(nil)

type JobStore struct {
	mu         sync.RWMutex
	nextID     uint64
	nextEvent  int64
	jobs       map[job.ID]job.Record
	attempts   map[job.ID][]attempt.Event
	byIdem     map[string]job.ID
	paused     map[string]bool
	rateLimits map[string]queueRateLimitState
	admission  map[string]admission.Policy
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
		attempts:   make(map[job.ID][]attempt.Event),
		byIdem:     make(map[string]job.ID),
		paused:     make(map[string]bool),
		rateLimits: make(map[string]queueRateLimitState),
		admission:  make(map[string]admission.Policy),
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

	now := s.clock()
	class, err := job.NormalizeClass(input.Class)
	if err != nil {
		return "", err
	}
	if input.RunAfter < 0 {
		return "", errors.New("run-after delay must not be negative")
	}
	notBefore := now.Add(input.RunAfter)
	if policy, ok := s.admission[input.Name]; ok {
		decision, err := policy.Decide(input.Name, s.pendingCount(input.Name), class.IsCritical())
		if err != nil {
			return "", err
		}
		if decision.DeferBy > 0 {
			notBefore = notBefore.Add(decision.DeferBy)
		}
	}

	s.nextID++
	id := job.ID(fmt.Sprintf("job_%06d", s.nextID))
	record, err := job.NewRecord(job.Spec{
		ID: id, Name: input.Name, Payload: input.Payload,
		Now: now, NotBefore: notBefore, Priority: input.Priority, Class: class,
	})
	if err != nil {
		s.nextID--
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
	return cloneRecord(record), true, nil
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

func (s *JobStore) ListAttemptEvents(_ context.Context, id ports.JobID, offset, limit int) ([]attempt.Event, error) {
	if id == "" || offset < 0 || limit <= 0 || limit > 1000 {
		return nil, errors.New("job id, non-negative offset and limit between 1 and 1000 are required")
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	if _, ok := s.jobs[id]; !ok {
		return nil, ports.ErrJobNotFound
	}
	events := s.attempts[id]
	if offset >= len(events) {
		return []attempt.Event{}, nil
	}
	end := offset + limit
	if end > len(events) {
		end = len(events)
	}
	result := make([]attempt.Event, end-offset)
	copy(result, events[offset:end])
	return result, nil
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
	if input.Owner == "" || input.Limit <= 0 || input.LeaseDuration <= 0 || input.Now.IsZero() {
		return nil, errors.New("claim requires an owner, a positive limit, a lease duration and a current time")
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	candidates := make([]job.Record, 0, len(s.jobs))
	for _, record := range s.jobs {
		if claimable(record, input.Now) && !s.paused[record.Name] {
			candidates = append(candidates, record)
		}
	}
	sortByClaimOrder(candidates, input.Now)

	claimed := make([]job.Record, 0, input.Limit)
	for _, record := range candidates {
		if len(claimed) == input.Limit {
			break
		}
		if !s.reserveRateSlot(record.Name, input.Now) {
			continue
		}
		record.State = job.Leased
		record.Attempts++
		record.BlockedReason = ""
		record.LeaseOwner = input.Owner
		record.LeaseEpoch++
		record.LeaseUntil = input.Now.Add(input.LeaseDuration)
		s.jobs[record.ID] = record
		s.appendAttempt(attempt.Event{
			JobID: record.ID, Attempt: record.Attempts, LeaseOwner: record.LeaseOwner,
			LeaseEpoch: record.LeaseEpoch, Kind: attempt.Claimed, ResultState: job.Leased,
			OccurredAt: input.Now,
		})
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

func (s *JobStore) SetQueueAdmission(_ context.Context, name string, policy admission.Policy) error {
	if name == "" {
		return errors.New("queue name is required")
	}
	normalized := policy.Normalize()
	if err := normalized.Validate(); err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.admission[name] = normalized
	return nil
}

func (s *JobStore) RemoveQueueAdmission(_ context.Context, name string) error {
	if name == "" {
		return errors.New("queue name is required")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.admission, name)
	return nil
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

func (s *JobStore) CheckLease(_ context.Context, lease ports.Lease, now time.Time) error {
	if !lease.Valid() || now.IsZero() {
		return ports.LeaseLost(lease, "the presented lease is incomplete")
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	if _, err := s.authoritative(lease, now); err != nil {
		return err
	}
	return nil
}

func (s *JobStore) RenewLease(_ context.Context, lease ports.Lease, now time.Time, extension time.Duration) (ports.LeaseStatus, error) {
	if !lease.Valid() || extension <= 0 || now.IsZero() {
		return ports.LeaseStatus{}, ports.LeaseLost(lease, "the presented lease is incomplete")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	record, err := s.authoritative(lease, now)
	if err != nil {
		return ports.LeaseStatus{}, err
	}
	record.LeaseUntil = now.Add(extension)
	s.jobs[record.ID] = record
	return ports.LeaseStatus{ExpiresAt: record.LeaseUntil, CancelRequested: record.CancelRequested}, nil
}

func (s *JobStore) Complete(_ context.Context, lease ports.Lease, now time.Time) error {
	if !lease.Valid() || now.IsZero() {
		return ports.LeaseLost(lease, "the presented lease is incomplete")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	record, err := s.authoritative(lease, now)
	if err != nil {
		return err
	}
	record.State = job.Succeeded
	record.LeaseOwner = ""
	record.LeaseUntil = time.Time{}
	s.jobs[record.ID] = record
	s.appendAttempt(attempt.Event{
		JobID: record.ID, Attempt: record.Attempts, LeaseOwner: lease.Owner,
		LeaseEpoch: lease.Epoch, Kind: attempt.Succeeded, ResultState: job.Succeeded,
		OccurredAt: now,
	})
	return nil
}

func (s *JobStore) ReleaseLease(_ context.Context, lease ports.Lease, now time.Time) error {
	if !lease.Valid() || now.IsZero() {
		return ports.LeaseLost(lease, "the presented lease is incomplete")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	record, err := s.authoritative(lease, now)
	if err != nil {
		return err
	}
	releasedAttempt := record.Attempts
	record.State = job.RetryWait
	record.NotBefore = now
	record.LeaseOwner = ""
	record.LeaseUntil = time.Time{}
	if record.Attempts > 0 {
		record.Attempts--
	}
	s.jobs[record.ID] = record
	s.appendAttempt(attempt.Event{
		JobID: record.ID, Attempt: releasedAttempt, LeaseOwner: lease.Owner,
		LeaseEpoch: lease.Epoch, Kind: attempt.Released, ResultState: job.RetryWait,
		OccurredAt: now,
	})
	return nil
}

func (s *JobStore) Fail(_ context.Context, lease ports.Lease, now time.Time, transition ports.FailureTransition) error {
	if !lease.Valid() || now.IsZero() {
		return ports.LeaseLost(lease, "the presented lease is incomplete")
	}
	if transition.State != job.RetryWait && transition.State != job.Dead && transition.State != job.Blocked && transition.State != job.Cancelled {
		return errors.New("invalid failure state")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	record, err := s.authoritative(lease, now)
	if err != nil {
		return err
	}
	record.State = transition.State
	retryIn := transition.RetryIn
	if retryIn < 0 {
		retryIn = 0
	}
	record.NotBefore = now.Add(retryIn)
	record.BlockedReason = ""
	if transition.State == job.Blocked {
		record.BlockedReason = transition.BlockedReason
		if record.BlockedReason == "" {
			record.BlockedReason = job.BlockedUnclassified
		}
	}
	record.LeaseOwner = ""
	record.LeaseUntil = time.Time{}
	s.jobs[record.ID] = record
	kind, _ := attempt.ResultKind(transition.State)
	s.appendAttempt(attempt.Event{
		JobID: record.ID, Attempt: record.Attempts, LeaseOwner: lease.Owner,
		LeaseEpoch: lease.Epoch, Kind: kind, ResultState: transition.State,
		FailureClass: transition.FailureClass, BlockedReason: record.BlockedReason,
		OccurredAt: now,
	})
	return nil
}

func (s *JobStore) RequestCancel(_ context.Context, id ports.JobID) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	record, ok := s.jobs[id]
	if !ok {
		return ports.ErrJobNotFound
	}
	switch record.State {
	case job.Pending, job.RetryWait, job.Blocked:
		record.State = job.Cancelled
		record.BlockedReason = ""
		record.LeaseOwner = ""
		record.LeaseUntil = time.Time{}
	case job.Leased:
		record.CancelRequested = true
	case job.Succeeded, job.Dead, job.Cancelled:
		return nil
	default:
		return errors.New("job cannot be cancelled in current state")
	}
	s.jobs[id] = record
	return nil
}

func (s *JobStore) IsCancelRequested(_ context.Context, id ports.JobID) (bool, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	record, ok := s.jobs[id]
	if !ok {
		return false, ports.ErrJobNotFound
	}
	return record.CancelRequested, nil
}

func (s *JobStore) RequeueExpired(_ context.Context, input ports.ReapInput) (ports.ReapResult, error) {
	if input.Now.IsZero() {
		return ports.ReapResult{}, errors.New("reaper time is required")
	}
	protection := input.Protection.Normalize()
	s.mu.Lock()
	defer s.mu.Unlock()
	var result ports.ReapResult
	for id, record := range s.jobs {
		if record.State != job.Leased || record.LeaseUntil.IsZero() || record.LeaseUntil.After(input.Now) {
			continue
		}
		owner := record.LeaseOwner
		result.Expired = append(result.Expired, ports.ExpiredLease{JobID: id, Epoch: record.LeaseEpoch})
		record.CrashCount++
		record.LeaseOwner = ""
		record.LeaseUntil = time.Time{}
		record.NotBefore = input.Now
		if protection.IsPoisoned(record.CrashCount) {
			record.State = job.Blocked
			record.BlockedReason = job.BlockedPoisonJob
			result.Blocked++
		} else {
			record.State = job.RetryWait
			result.Requeued++
		}
		s.jobs[id] = record
		s.appendAttempt(attempt.Event{
			JobID: id, Attempt: record.Attempts, LeaseOwner: owner,
			LeaseEpoch: record.LeaseEpoch, Kind: attempt.LeaseExpired,
			ResultState: record.State, BlockedReason: record.BlockedReason,
			OccurredAt: input.Now,
		})
	}
	return result, nil
}

// appendAttempt is called only while s.mu is held, making the evidence update
// atomic with the corresponding hot-state transition.
func (s *JobStore) appendAttempt(event attempt.Event) {
	s.nextEvent++
	event.Sequence = s.nextEvent
	s.attempts[event.JobID] = append(s.attempts[event.JobID], event)
}

// authoritative resolves a fencing token to the live record. Owner and epoch
// must both match, and the lease must not have expired.
func (s *JobStore) authoritative(lease ports.Lease, now time.Time) (job.Record, error) {
	record, ok := s.jobs[lease.JobID]
	if !ok {
		return job.Record{}, ports.LeaseLost(lease, "the job no longer exists")
	}
	if record.State != job.Leased {
		return job.Record{}, ports.LeaseLost(lease, "the job is "+record.State.String()+", not leased")
	}
	if record.LeaseOwner != lease.Owner {
		return job.Record{}, ports.LeaseLost(lease, "the job is leased to "+record.LeaseOwner)
	}
	if record.LeaseEpoch != lease.Epoch {
		return job.Record{}, ports.LeaseLost(lease, fmt.Sprintf("the job is at epoch %d", record.LeaseEpoch))
	}
	if !record.LeaseUntil.After(now) {
		return job.Record{}, ports.LeaseLost(lease, "the lease expired at "+record.LeaseUntil.Format(time.RFC3339Nano))
	}
	return record, nil
}

func (s *JobStore) pendingCount(name string) int {
	count := 0
	for _, record := range s.jobs {
		if record.Name == name && (record.State == job.Pending || record.State == job.RetryWait) {
			count++
		}
	}
	return count
}

func claimable(record job.Record, now time.Time) bool {
	return (record.State == job.Pending || record.State == job.RetryWait) && !record.NotBefore.After(now)
}

// sortByClaimOrder is design A of specification 28.1: effective priority first,
// then FIFO by creation time inside the same effective priority.
func sortByClaimOrder(records []job.Record, now time.Time) {
	sort.Slice(records, func(i, j int) bool {
		left := job.EffectivePriority(records[i].Priority, records[i].NotBefore, now)
		right := job.EffectivePriority(records[j].Priority, records[j].NotBefore, now)
		if left != right {
			return left > right
		}
		if !records[i].CreatedAt.Equal(records[j].CreatedAt) {
			return records[i].CreatedAt.Before(records[j].CreatedAt)
		}
		return records[i].ID < records[j].ID
	})
}

func (s *JobStore) reserveRateSlot(name string, now time.Time) bool {
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
