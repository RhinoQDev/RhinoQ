package tasks

import (
	"context"
	"errors"
	"time"

	taskcontract "github.com/madebyduy/RhinoQ/internal/contracts/task"
	"github.com/madebyduy/RhinoQ/internal/domain/execution"
	"github.com/madebyduy/RhinoQ/internal/domain/task"
	"github.com/madebyduy/RhinoQ/internal/ports"
)

type Service struct {
	tasks      ports.TaskStore
	executions ports.ExecutionStore
	now        func() time.Time
}

func New(taskStore ports.TaskStore, executionStore ports.ExecutionStore, now func() time.Time) (*Service, error) {
	if taskStore == nil || executionStore == nil {
		return nil, errors.New("task and execution stores are required")
	}
	if now == nil {
		now = func() time.Time { return time.Now().UTC() }
	}
	return &Service{tasks: taskStore, executions: executionStore, now: now}, nil
}

type CreateInput struct {
	ID                task.ID
	Type              string
	OwnerID           string
	DefinitionVersion int
}

func (s *Service) Create(ctx context.Context, input CreateInput) (task.Record, error) {
	record, err := task.NewRecord(task.Spec{
		ID: input.ID, Type: input.Type, OwnerID: input.OwnerID,
		DefinitionVersion: input.DefinitionVersion, Now: s.now(),
	})
	if err != nil {
		return task.Record{}, err
	}
	return s.tasks.CreateTask(ctx, record)
}

type CreateExecutionInput struct {
	ID      execution.ID
	TaskID  task.ID
	Runtime string
}

func (s *Service) CreateExecution(ctx context.Context, input CreateExecutionInput) (execution.Record, error) {
	if _, found, err := s.tasks.GetTask(ctx, input.TaskID); err != nil {
		return execution.Record{}, err
	} else if !found {
		return execution.Record{}, ports.ErrTaskNotFound
	}
	record, _, err := s.executions.CreateNextExecution(ctx, ports.ExecutionCreateInput{
		ID: input.ID, TaskID: input.TaskID.String(), Runtime: input.Runtime, Now: s.now(),
	})
	return record, err
}

func (s *Service) BindExecution(ctx context.Context, id execution.ID, reference execution.RuntimeReference) (execution.Record, error) {
	record, found, err := s.executions.GetExecution(ctx, id)
	if err != nil {
		return execution.Record{}, err
	}
	if !found {
		return execution.Record{}, ports.ErrExecutionNotFound
	}
	expectedVersion := record.Version
	record, err = record.Bind(reference, s.now())
	if err != nil {
		return execution.Record{}, err
	}
	record, _, err = s.executions.UpdateExecution(ctx, record, expectedVersion)
	return record, err
}

func (s *Service) Get(ctx context.Context, id task.ID) (taskcontract.Snapshot, error) {
	record, found, err := s.tasks.GetTask(ctx, id)
	if err != nil {
		return taskcontract.Snapshot{}, err
	}
	if !found {
		return taskcontract.Snapshot{}, ports.ErrTaskNotFound
	}
	executions, err := s.executions.ListTaskExecutions(ctx, id.String())
	if err != nil {
		return taskcontract.Snapshot{}, err
	}
	return newSnapshot(record, executions)
}

func (s *Service) Transition(ctx context.Context, id task.ID, expectedVersion int64, to task.State) (taskcontract.Snapshot, error) {
	record, found, err := s.tasks.GetTask(ctx, id)
	if err != nil {
		return taskcontract.Snapshot{}, err
	}
	if !found {
		return taskcontract.Snapshot{}, ports.ErrTaskNotFound
	}
	if record.Version != expectedVersion {
		return taskcontract.Snapshot{}, ports.ErrVersionConflict
	}
	record, err = record.Transition(to, s.now())
	if err != nil {
		return taskcontract.Snapshot{}, err
	}
	if _, err := s.tasks.UpdateTask(ctx, record, expectedVersion); err != nil {
		return taskcontract.Snapshot{}, err
	}
	return s.Get(ctx, id)
}

func (s *Service) UpdateProgress(ctx context.Context, id task.ID, expectedVersion int64, progress task.Progress) (taskcontract.Snapshot, error) {
	record, found, err := s.tasks.GetTask(ctx, id)
	if err != nil {
		return taskcontract.Snapshot{}, err
	}
	if !found {
		return taskcontract.Snapshot{}, ports.ErrTaskNotFound
	}
	if record.Version != expectedVersion {
		return taskcontract.Snapshot{}, ports.ErrVersionConflict
	}
	record, err = record.ApplyProgress(progress, s.now())
	if err != nil {
		return taskcontract.Snapshot{}, err
	}
	if _, err := s.tasks.UpdateTask(ctx, record, expectedVersion); err != nil {
		return taskcontract.Snapshot{}, err
	}
	return s.Get(ctx, id)
}
