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

// AttachExecutionResult records where one attempt's output landed. The Task
// keeps its own aggregate reference; this is the per-item answer a fan-out
// needs so the application does not have to keep a parallel item store.
func (s *Service) AttachExecutionResult(
	ctx context.Context,
	id execution.ID,
	expectedVersion int64,
	reference string,
) (taskcontract.Snapshot, error) {
	return s.mutateExecution(ctx, id, expectedVersion, func(record execution.Record) (execution.Record, error) {
		return record.AttachResult(reference, s.now())
	})
}

// FailExecutionSnapshot is TransitionExecutionSnapshot(failed) plus the reason
// the user is owed for this item.
func (s *Service) FailExecutionSnapshot(
	ctx context.Context,
	id execution.ID,
	expectedVersion int64,
	reason string,
) (taskcontract.Snapshot, error) {
	return s.mutateExecution(ctx, id, expectedVersion, func(record execution.Record) (execution.Record, error) {
		return record.Fail(reason, s.now())
	})
}

// ListExecutionResults answers "what happened to each item" in one read, so a
// batch view does not have to poll one endpoint per attempt.
func (s *Service) ListExecutionResults(
	ctx context.Context,
	id task.ID,
) (taskcontract.ExecutionResults, error) {
	record, found, err := s.tasks.GetTask(ctx, id)
	if err != nil {
		return taskcontract.ExecutionResults{}, err
	}
	if !found {
		return taskcontract.ExecutionResults{}, ports.ErrTaskNotFound
	}
	attempts, err := s.executions.ListTaskExecutions(ctx, id.String())
	if err != nil {
		return taskcontract.ExecutionResults{}, err
	}
	return newExecutionResults(record, attempts)
}

func (s *Service) mutateExecution(
	ctx context.Context,
	id execution.ID,
	expectedVersion int64,
	apply func(execution.Record) (execution.Record, error),
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
	next, err := apply(record)
	if err != nil {
		return taskcontract.Snapshot{}, err
	}
	// A command that changes nothing consumes no version, exactly as the Task
	// commands behave.
	if next.Version == record.Version {
		return s.Get(ctx, task.ID(record.TaskID))
	}
	if _, _, err := s.executions.UpdateExecution(ctx, next, expectedVersion); err != nil {
		return taskcontract.Snapshot{}, err
	}
	return s.Get(ctx, task.ID(record.TaskID))
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
