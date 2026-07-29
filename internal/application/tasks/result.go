package tasks

import (
	"context"
	"sort"

	taskcontract "github.com/madebyduy/RhinoQ/internal/contracts/task"
	"github.com/madebyduy/RhinoQ/internal/domain/execution"
	"github.com/madebyduy/RhinoQ/internal/domain/task"
	"github.com/madebyduy/RhinoQ/internal/ports"
)

func (s *Service) AttachResult(
	ctx context.Context,
	id task.ID,
	expectedVersion int64,
	reference string,
) (taskcontract.Result, error) {
	record, found, err := s.tasks.GetTask(ctx, id)
	if err != nil {
		return taskcontract.Result{}, err
	}
	if !found {
		return taskcontract.Result{}, ports.ErrTaskNotFound
	}
	if record.Version != expectedVersion {
		return taskcontract.Result{}, ports.ErrVersionConflict
	}
	record, err = record.AttachResult(reference, s.now())
	if err != nil {
		return taskcontract.Result{}, err
	}
	record, err = s.tasks.UpdateTask(ctx, record, expectedVersion)
	if err != nil {
		return taskcontract.Result{}, err
	}
	return newResult(record)
}

func (s *Service) GetResult(ctx context.Context, id task.ID) (taskcontract.Result, error) {
	record, found, err := s.tasks.GetTask(ctx, id)
	if err != nil {
		return taskcontract.Result{}, err
	}
	if !found {
		return taskcontract.Result{}, ports.ErrTaskNotFound
	}
	if record.ResultRef == "" {
		return taskcontract.Result{}, ports.ErrTaskResultNotFound
	}
	return newResult(record)
}

func newExecutionResults(
	record task.Record,
	attempts []execution.Record,
) (taskcontract.ExecutionResults, error) {
	items := make([]taskcontract.ExecutionResult, 0, len(attempts))
	for _, attempt := range attempts {
		if attempt.TaskID != record.ID.String() {
			return taskcontract.ExecutionResults{}, taskcontract.ErrInvalidResult
		}
		items = append(items, taskcontract.ExecutionResult{
			ExecutionID:   attempt.ID.String(),
			Attempt:       attempt.Attempt,
			State:         attempt.State.String(),
			Reference:     attempt.ResultRef,
			FailureReason: attempt.FailureReason,
			UpdatedAt:     attempt.UpdatedAt,
		})
	}
	sort.Slice(items, func(i, j int) bool { return items[i].Attempt < items[j].Attempt })
	results := taskcontract.ExecutionResults{
		SchemaVersion: taskcontract.ResultSchemaVersion,
		EntityVersion: record.Version,
		TaskID:        record.ID.String(),
		Executions:    items,
	}
	if err := results.Validate(); err != nil {
		return taskcontract.ExecutionResults{}, err
	}
	return results, nil
}

func newResult(record task.Record) (taskcontract.Result, error) {
	result := taskcontract.Result{
		SchemaVersion: taskcontract.ResultSchemaVersion,
		EntityVersion: record.Version,
		TaskID:        record.ID.String(),
		Reference:     record.ResultRef,
		UpdatedAt:     record.UpdatedAt,
	}
	if err := result.Validate(); err != nil {
		return taskcontract.Result{}, err
	}
	return result, nil
}
