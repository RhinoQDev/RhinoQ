package memory

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"sync"
	"time"

	"github.com/madebyduy/RhinoQ/internal/domain/execution"
	"github.com/madebyduy/RhinoQ/internal/domain/task"
	"github.com/madebyduy/RhinoQ/internal/domain/waitpoint"
	"github.com/madebyduy/RhinoQ/internal/ports"
)

var (
	_ ports.TaskStore      = (*TaskStore)(nil)
	_ ports.ExecutionStore = (*TaskStore)(nil)
	_ ports.TaskRetryStore = (*TaskStore)(nil)
	_ ports.WaitpointStore = (*TaskStore)(nil)
)

type TaskStore struct {
	mu                sync.RWMutex
	tasks             map[task.ID]task.Record
	executions        map[execution.ID]execution.Record
	attempts          map[string]map[int]execution.ID
	retries           map[string]ports.TaskRetryResult
	retryFingerprints map[string][32]byte
	waitpoints        map[waitpoint.ID]waitpoint.Record
	waitpointKeys     map[string]waitpoint.ID
}

func NewTaskStore() *TaskStore {
	return &TaskStore{
		tasks:             make(map[task.ID]task.Record),
		executions:        make(map[execution.ID]execution.Record),
		attempts:          make(map[string]map[int]execution.ID),
		retries:           make(map[string]ports.TaskRetryResult),
		retryFingerprints: make(map[string][32]byte),
		waitpoints:        make(map[waitpoint.ID]waitpoint.Record),
		waitpointKeys:     make(map[string]waitpoint.ID),
	}
}

func waitpointKey(taskID, key string) string { return taskID + "\x00" + key }

func (s *TaskStore) CreateWaitpoint(_ context.Context, record waitpoint.Record) (waitpoint.Record, bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, found := s.tasks[task.ID(record.TaskID)]; !found {
		return waitpoint.Record{}, false, ports.ErrTaskNotFound
	}
	identity := waitpointKey(record.TaskID, record.Key)
	if id, found := s.waitpointKeys[identity]; found {
		prior := s.waitpoints[id]
		if prior.ID != record.ID || prior.Kind != record.Kind || prior.SchemaVersion != record.SchemaVersion || !prior.Deadline.Equal(record.Deadline) {
			return waitpoint.Record{}, false, ports.ErrWaitpointConflict
		}
		return prior, true, nil
	}
	if _, found := s.waitpoints[record.ID]; found {
		return waitpoint.Record{}, false, ports.ErrAlreadyExists
	}
	s.waitpoints[record.ID], s.waitpointKeys[identity] = record, record.ID
	parent := s.tasks[task.ID(record.TaskID)]
	parent.Version++
	if record.UpdatedAt.After(parent.UpdatedAt) {
		parent.UpdatedAt = record.UpdatedAt
	}
	s.tasks[parent.ID] = parent
	return record, false, nil
}

func (s *TaskStore) GetWaitpoint(_ context.Context, id waitpoint.ID) (waitpoint.Record, bool, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	r, ok := s.waitpoints[id]
	return r, ok, nil
}

func (s *TaskStore) GetTaskWaitpoint(_ context.Context, taskID, key string) (waitpoint.Record, bool, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	id, ok := s.waitpointKeys[waitpointKey(taskID, key)]
	if !ok {
		return waitpoint.Record{}, false, nil
	}
	return s.waitpoints[id], true, nil
}

func (s *TaskStore) UpdateWaitpoint(_ context.Context, record waitpoint.Record, expectedVersion int64) (waitpoint.Record, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	current, ok := s.waitpoints[record.ID]
	if !ok {
		return waitpoint.Record{}, ports.ErrWaitpointNotFound
	}
	// A duplicate resolve returns the unchanged durable record.
	if record.Version == expectedVersion && current.ID == record.ID && current.State == record.State &&
		current.ResolutionID == record.ResolutionID && current.ResolutionHash == record.ResolutionHash &&
		bytes.Equal(current.Resolution, record.Resolution) {
		return current, nil
	}
	if current.Version != expectedVersion || record.Version != expectedVersion+1 {
		return waitpoint.Record{}, ports.ErrVersionConflict
	}
	s.waitpoints[record.ID] = record
	parent := s.tasks[task.ID(record.TaskID)]
	parent.Version++
	if record.UpdatedAt.After(parent.UpdatedAt) {
		parent.UpdatedAt = record.UpdatedAt
	}
	s.tasks[parent.ID] = parent
	return record, nil
}

func (s *TaskStore) ListDueWaitpoints(_ context.Context, now time.Time, limit int) ([]waitpoint.Record, error) {
	if now.IsZero() || limit <= 0 {
		return nil, errors.New("time and positive limit are required")
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	result := make([]waitpoint.Record, 0, limit)
	for _, r := range s.waitpoints {
		if r.State == waitpoint.Waiting && !r.Deadline.IsZero() && !now.Before(r.Deadline) {
			result = append(result, r)
		}
	}
	sort.Slice(result, func(i, j int) bool {
		if result[i].Deadline.Equal(result[j].Deadline) {
			return result[i].ID < result[j].ID
		}
		return result[i].Deadline.Before(result[j].Deadline)
	})
	if len(result) > limit {
		result = result[:limit]
	}
	return result, nil
}

func (s *TaskStore) RetryTask(_ context.Context, input ports.TaskRetryInput) (ports.TaskRetryResult, error) {
	if input.CommandID == "" || input.TaskID == "" || input.ExecutionID == "" || input.Runtime == "" || input.Queue == "" || input.JobName == "" || len(input.Payload) == 0 || !json.Valid(input.Payload) || input.ExpectedVersion <= 0 || input.Now.IsZero() {
		return ports.TaskRetryResult{}, errors.New("valid retry input is required")
	}
	fingerprint := sha256.Sum256(append([]byte(input.Runtime+"\x00"+input.Queue+"\x00"+input.JobName+"\x00"), input.Payload...))
	s.mu.Lock()
	defer s.mu.Unlock()
	if prior, ok := s.retries[input.CommandID]; ok {
		if prior.Task.ID != input.TaskID || prior.Execution.ID != input.ExecutionID || s.retryFingerprints[input.CommandID] != fingerprint {
			return ports.TaskRetryResult{}, fmt.Errorf("%w: retry command identity reused with different input", ports.ErrAlreadyExists)
		}
		prior.Replayed = true
		return prior, nil
	}
	parent, ok := s.tasks[input.TaskID]
	if !ok {
		return ports.TaskRetryResult{}, ports.ErrTaskNotFound
	}
	if parent.Version != input.ExpectedVersion {
		return ports.TaskRetryResult{}, ports.ErrVersionConflict
	}
	next, err := parent.Transition(task.Queued, input.Now)
	if err != nil {
		return ports.TaskRetryResult{}, err
	}
	if _, exists := s.executions[input.ExecutionID]; exists {
		return ports.TaskRetryResult{}, ports.ErrAlreadyExists
	}
	byAttempt := s.attempts[input.TaskID.String()]
	if byAttempt == nil {
		byAttempt = make(map[int]execution.ID)
		s.attempts[input.TaskID.String()] = byAttempt
	}
	attempt := 1
	for number := range byAttempt {
		if number >= attempt {
			attempt = number + 1
		}
	}
	executionRecord, err := execution.NewRecord(execution.Spec{ID: input.ExecutionID, TaskID: input.TaskID.String(), Attempt: attempt, Runtime: input.Runtime, Trace: input.Trace, Now: input.Now})
	if err != nil {
		return ports.TaskRetryResult{}, err
	}
	next.ExecutionCounts.Total++
	next.ExecutionCounts.PendingDispatch++
	s.tasks[input.TaskID] = next
	s.executions[input.ExecutionID] = executionRecord
	byAttempt[attempt] = input.ExecutionID
	result := ports.TaskRetryResult{Task: next, Execution: executionRecord}
	s.retries[input.CommandID] = result
	s.retryFingerprints[input.CommandID] = fingerprint
	return result, nil
}

func (s *TaskStore) CreateTask(_ context.Context, record task.Record) (task.Record, error) {
	if record.ID == "" || record.Version != 1 {
		return task.Record{}, task.ErrInvalidRecord
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, exists := s.tasks[record.ID]; exists {
		return task.Record{}, fmt.Errorf("%w: task %s", ports.ErrAlreadyExists, record.ID)
	}
	s.tasks[record.ID] = record
	return record, nil
}

func (s *TaskStore) GetTask(_ context.Context, id task.ID) (task.Record, bool, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	record, found := s.tasks[id]
	return record, found, nil
}

func (s *TaskStore) UpdateTask(_ context.Context, record task.Record, expectedVersion int64) (task.Record, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	current, found := s.tasks[record.ID]
	if !found {
		return task.Record{}, ports.ErrTaskNotFound
	}
	if current.Version != expectedVersion || record.Version != expectedVersion+1 {
		return task.Record{}, ports.ErrVersionConflict
	}
	s.tasks[record.ID] = record
	return record, nil
}

func (s *TaskStore) CreateNextExecution(_ context.Context, input ports.ExecutionCreateInput) (execution.Record, int64, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	taskID := task.ID(input.TaskID)
	parent, found := s.tasks[taskID]
	if !found {
		return execution.Record{}, 0, ports.ErrTaskNotFound
	}
	if _, exists := s.executions[input.ID]; exists {
		return execution.Record{}, 0, fmt.Errorf("%w: execution %s", ports.ErrAlreadyExists, input.ID)
	}
	byAttempt := s.attempts[input.TaskID]
	if byAttempt == nil {
		byAttempt = make(map[int]execution.ID)
		s.attempts[input.TaskID] = byAttempt
	}
	attempt := 1
	for number := range byAttempt {
		if number >= attempt {
			attempt = number + 1
		}
	}
	record, err := execution.NewRecord(execution.Spec{
		ID: input.ID, TaskID: input.TaskID, Attempt: attempt,
		Runtime: input.Runtime, Trace: input.Trace, Now: input.Now,
	})
	if err != nil {
		return execution.Record{}, 0, err
	}
	s.executions[record.ID] = record
	byAttempt[record.Attempt] = record.ID
	parent.ExecutionCounts.Total++
	parent.ExecutionCounts.PendingDispatch++
	parent.Version++
	if input.Now.After(parent.UpdatedAt) {
		parent.UpdatedAt = input.Now
	}
	s.tasks[taskID] = parent
	return record, parent.Version, nil
}

func (s *TaskStore) GetExecution(_ context.Context, id execution.ID) (execution.Record, bool, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	record, found := s.executions[id]
	return record, found, nil
}

func (s *TaskStore) FindExecutionByExternalReference(_ context.Context, runtime, externalID string) (execution.Record, bool, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	for _, record := range s.executions {
		if record.Runtime == runtime && record.Reference.ExternalID == externalID {
			return record, true, nil
		}
	}
	return execution.Record{}, false, nil
}

func (s *TaskStore) UpdateExecution(_ context.Context, record execution.Record, expectedVersion int64) (execution.Record, int64, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	current, found := s.executions[record.ID]
	if !found {
		return execution.Record{}, 0, ports.ErrExecutionNotFound
	}
	if current.Version != expectedVersion || record.Version != expectedVersion+1 {
		return execution.Record{}, 0, ports.ErrVersionConflict
	}
	if current.TaskID != record.TaskID || current.Attempt != record.Attempt {
		return execution.Record{}, 0, execution.ErrInvalidRecord
	}
	taskID := task.ID(record.TaskID)
	parent, found := s.tasks[taskID]
	if !found {
		return execution.Record{}, 0, ports.ErrTaskNotFound
	}
	s.executions[record.ID] = record
	if current.State != record.State {
		adjustExecutionCount(&parent.ExecutionCounts, current.State, -1)
		adjustExecutionCount(&parent.ExecutionCounts, record.State, 1)
	}
	parent.Version++
	if record.UpdatedAt.After(parent.UpdatedAt) {
		parent.UpdatedAt = record.UpdatedAt
	}
	s.tasks[taskID] = parent
	return record, parent.Version, nil
}

func adjustExecutionCount(counts *task.ExecutionCounts, state execution.State, delta int64) {
	switch state {
	case execution.PendingDispatch:
		counts.PendingDispatch += delta
	case execution.Dispatched:
		counts.Dispatched += delta
	case execution.Running:
		counts.Running += delta
	case execution.Succeeded:
		counts.Succeeded += delta
	case execution.Failed:
		counts.Failed += delta
	case execution.Stalled:
		counts.Stalled += delta
	case execution.Cancelled:
		counts.Cancelled += delta
	}
}

func (s *TaskStore) ListTaskExecutions(_ context.Context, taskID string) ([]execution.Record, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	records := make([]execution.Record, 0, len(s.attempts[taskID]))
	for _, id := range s.attempts[taskID] {
		records = append(records, s.executions[id])
	}
	sort.Slice(records, func(i, j int) bool {
		if records[i].Attempt == records[j].Attempt {
			return records[i].ID < records[j].ID
		}
		return records[i].Attempt < records[j].Attempt
	})
	return records, nil
}

func (s *TaskStore) ListTaskExecutionsPage(_ context.Context, query ports.ExecutionPageQuery) ([]execution.Record, bool, error) {
	if query.TaskID == "" || query.Limit <= 0 {
		return nil, false, errors.New("task id and positive page limit are required")
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	all := make([]execution.Record, 0, len(s.attempts[query.TaskID]))
	var after execution.Record
	if query.AfterID != "" {
		var found bool
		after, found = s.executions[execution.ID(query.AfterID)]
		if !found || after.TaskID != query.TaskID {
			return nil, false, errors.New("invalid execution cursor")
		}
	}
	for _, id := range s.attempts[query.TaskID] {
		record := s.executions[id]
		if query.AfterID != "" && (record.CreatedAt.Before(after.CreatedAt) ||
			(record.CreatedAt.Equal(after.CreatedAt) && record.ID.String() <= query.AfterID)) {
			continue
		}
		all = append(all, record)
	}
	sort.Slice(all, func(i, j int) bool {
		if all[i].CreatedAt.Equal(all[j].CreatedAt) {
			return all[i].ID < all[j].ID
		}
		return all[i].CreatedAt.Before(all[j].CreatedAt)
	})
	more := len(all) > query.Limit
	if more {
		all = all[:query.Limit]
	}
	return all, more, nil
}
