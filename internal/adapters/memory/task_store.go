package memory

import (
	"context"
	"fmt"
	"sort"
	"sync"

	"github.com/madebyduy/RhinoQ/internal/domain/execution"
	"github.com/madebyduy/RhinoQ/internal/domain/task"
	"github.com/madebyduy/RhinoQ/internal/ports"
)

var (
	_ ports.TaskStore      = (*TaskStore)(nil)
	_ ports.ExecutionStore = (*TaskStore)(nil)
)

type TaskStore struct {
	mu         sync.RWMutex
	tasks      map[task.ID]task.Record
	executions map[execution.ID]execution.Record
	attempts   map[string]map[int]execution.ID
}

func NewTaskStore() *TaskStore {
	return &TaskStore{
		tasks:      make(map[task.ID]task.Record),
		executions: make(map[execution.ID]execution.Record),
		attempts:   make(map[string]map[int]execution.ID),
	}
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
		Runtime: input.Runtime, Now: input.Now,
	})
	if err != nil {
		return execution.Record{}, 0, err
	}
	s.executions[record.ID] = record
	byAttempt[record.Attempt] = record.ID
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
	parent.Version++
	if record.UpdatedAt.After(parent.UpdatedAt) {
		parent.UpdatedAt = record.UpdatedAt
	}
	s.tasks[taskID] = parent
	return record, parent.Version, nil
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
