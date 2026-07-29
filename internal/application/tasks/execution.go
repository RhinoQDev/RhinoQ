package tasks

import (
	"context"

	taskcontract "github.com/madebyduy/RhinoQ/internal/contracts/task"
	"github.com/madebyduy/RhinoQ/internal/domain/execution"
	"github.com/madebyduy/RhinoQ/internal/domain/task"
	"github.com/madebyduy/RhinoQ/internal/ports"
)

// CreateExecutionSnapshot returns the aggregate after the child mutation. The
// store advances Task.Version in the same critical section/transaction as the
// Execution insert, so this Snapshot can safely become the caller's next write
// precondition.
func (s *Service) CreateExecutionSnapshot(
	ctx context.Context,
	input CreateExecutionInput,
) (taskcontract.Snapshot, error) {
	if _, err := s.CreateExecution(ctx, input); err != nil {
		return taskcontract.Snapshot{}, err
	}
	return s.Get(ctx, input.TaskID)
}

func (s *Service) BindExecutionSnapshot(
	ctx context.Context,
	id execution.ID,
	reference execution.RuntimeReference,
) (taskcontract.Snapshot, error) {
	record, err := s.BindExecution(ctx, id, reference)
	if err != nil {
		return taskcontract.Snapshot{}, err
	}
	return s.Get(ctx, task.ID(record.TaskID))
}

// LookupExternalExecution returns the runtime-facing attempt record. It is not
// a user Snapshot: adapters need the Task ID and the execution version to
// resume observation after their own process restart.
func (s *Service) LookupExternalExecution(
	ctx context.Context,
	runtime, externalID string,
) (execution.Record, error) {
	record, found, err := s.executions.FindExecutionByExternalReference(ctx, runtime, externalID)
	if err != nil {
		return execution.Record{}, err
	}
	if !found {
		return execution.Record{}, ports.ErrExecutionNotFound
	}
	return record, nil
}

func (s *Service) GetExecution(ctx context.Context, id execution.ID) (execution.Record, error) {
	record, found, err := s.executions.GetExecution(ctx, id)
	if err != nil {
		return execution.Record{}, err
	}
	if !found {
		return execution.Record{}, ports.ErrExecutionNotFound
	}
	return record, nil
}

// TransitionExecutionSnapshot advances one existing attempt. Task state stays
// separate: a runtime adapter applies the user-facing Task transition through
// the normal Task command after it has observed the execution fact.
func (s *Service) TransitionExecutionSnapshot(
	ctx context.Context,
	id execution.ID,
	expectedVersion int64,
	to execution.State,
) (taskcontract.Snapshot, error) {
	record, found, err := s.executions.GetExecution(ctx, id)
	if err != nil {
		return taskcontract.Snapshot{}, err
	}
	if !found {
		return taskcontract.Snapshot{}, ports.ErrExecutionNotFound
	}
	if record.Version != expectedVersion {
		return taskcontract.Snapshot{}, ports.ErrVersionConflict
	}
	record, err = record.Transition(to, s.now())
	if err != nil {
		return taskcontract.Snapshot{}, err
	}
	if _, _, err := s.executions.UpdateExecution(ctx, record, expectedVersion); err != nil {
		return taskcontract.Snapshot{}, err
	}
	return s.Get(ctx, task.ID(record.TaskID))
}
