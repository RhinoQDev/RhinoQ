package tasks

import (
	"sort"

	taskcontract "github.com/madebyduy/RhinoQ/internal/contracts/task"
	"github.com/madebyduy/RhinoQ/internal/domain/execution"
	"github.com/madebyduy/RhinoQ/internal/domain/task"
)

// newSnapshot is the anti-corruption mapping between authoritative domain
// records and the stable read contract. Keeping it here prevents contracts
// from depending on domain implementation types.
func newSnapshot(record task.Record, attempts []execution.Record) (taskcontract.Snapshot, error) {
	if record.ID == "" || !record.State.Valid() || record.Version <= 0 ||
		record.CreatedAt.IsZero() || record.UpdatedAt.IsZero() {
		return taskcontract.Snapshot{}, taskcontract.ErrInvalidSnapshot
	}
	progress := taskcontract.Progress{
		Completed: record.Progress.Completed,
		Message:   record.Progress.Message,
	}
	if record.Progress.HasTotal {
		total := record.Progress.Total
		progress.Total = &total
	}
	executions := make([]taskcontract.Execution, 0, len(attempts))
	for _, attempt := range attempts {
		if attempt.TaskID != record.ID.String() || attempt.ID == "" ||
			attempt.Attempt <= 0 || !attempt.State.Valid() || attempt.Version <= 0 {
			return taskcontract.Snapshot{}, taskcontract.ErrInvalidSnapshot
		}
		executions = append(executions, taskcontract.Execution{
			ID:            attempt.ID.String(),
			Attempt:       attempt.Attempt,
			Runtime:       attempt.Runtime,
			State:         attempt.State.String(),
			Version:       attempt.Version,
			HasResult:     attempt.ResultRef != "",
			FailureReason: attempt.FailureReason,
		})
	}
	sort.Slice(executions, func(i, j int) bool {
		return executions[i].Attempt < executions[j].Attempt
	})
	snapshot := taskcontract.Snapshot{
		SchemaVersion: taskcontract.SnapshotSchemaVersion,
		EntityVersion: record.Version,
		ID:            record.ID.String(),
		Type:          record.Type,
		OwnerID:       record.OwnerID,
		State:         record.State.String(),
		Cancellation: taskcontract.Cancellation{
			Status: string(record.CancellationStatus),
			Reason: record.CancellationReason,
		},
		Progress:   progress,
		HasResult:  record.ResultRef != "",
		Executions: executions,
		CreatedAt:  record.CreatedAt,
		UpdatedAt:  record.UpdatedAt,
	}
	if err := snapshot.Validate(); err != nil {
		return taskcontract.Snapshot{}, err
	}
	return snapshot, nil
}
