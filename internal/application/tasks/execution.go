package tasks

import (
	"context"

	taskcontract "github.com/madebyduy/RhinoQ/internal/contracts/task"
	"github.com/madebyduy/RhinoQ/internal/domain/execution"
	"github.com/madebyduy/RhinoQ/internal/domain/task"
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
