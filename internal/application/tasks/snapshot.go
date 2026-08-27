package tasks

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"sort"

	taskcontract "github.com/madebyduy/RhinoQ/internal/contracts/task"
	"github.com/madebyduy/RhinoQ/internal/domain/execution"
	"github.com/madebyduy/RhinoQ/internal/domain/task"
)

const maxExecutionPageSize = 500

type executionCursor struct {
	ID string `json:"id"`
}

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
			TraceID:       attempt.Trace.TraceID,
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

func newSummary(record task.Record) (taskcontract.Summary, error) {
	snapshot, err := newSnapshot(record, nil)
	if err != nil {
		return taskcontract.Summary{}, err
	}
	return taskcontract.Summary{
		SchemaVersion: snapshot.SchemaVersion, EntityVersion: snapshot.EntityVersion,
		ID: snapshot.ID, Type: snapshot.Type, OwnerID: snapshot.OwnerID,
		State: snapshot.State, Cancellation: snapshot.Cancellation,
		Progress: snapshot.Progress, HasResult: snapshot.HasResult,
		ExecutionCounts: taskcontract.ExecutionCounts{
			Total:           record.ExecutionCounts.Total,
			PendingDispatch: record.ExecutionCounts.PendingDispatch,
			Dispatched:      record.ExecutionCounts.Dispatched,
			Running:         record.ExecutionCounts.Running,
			Succeeded:       record.ExecutionCounts.Succeeded,
			Failed:          record.ExecutionCounts.Failed,
			Stalled:         record.ExecutionCounts.Stalled,
			Cancelled:       record.ExecutionCounts.Cancelled,
		},
		CreatedAt: snapshot.CreatedAt, UpdatedAt: snapshot.UpdatedAt,
	}, nil
}

func executionContract(record execution.Record) (taskcontract.Execution, error) {
	if record.ID == "" || record.Attempt <= 0 || record.Runtime == "" ||
		!record.State.Valid() || record.Version <= 0 {
		return taskcontract.Execution{}, taskcontract.ErrInvalidSnapshot
	}
	return taskcontract.Execution{
		ID: record.ID.String(), Attempt: record.Attempt, Runtime: record.Runtime,
		State: record.State.String(), Version: record.Version,
		HasResult: record.ResultRef != "", FailureReason: record.FailureReason,
		TraceID: record.Trace.TraceID,
	}, nil
}

func decodeExecutionCursor(value string) (executionCursor, error) {
	if value == "" {
		return executionCursor{}, nil
	}
	body, err := base64.RawURLEncoding.DecodeString(value)
	if err != nil {
		return executionCursor{}, errors.New("invalid execution cursor")
	}
	var cursor executionCursor
	if err := json.Unmarshal(body, &cursor); err != nil || cursor.ID == "" {
		return executionCursor{}, errors.New("invalid execution cursor")
	}
	return cursor, nil
}

func encodeExecutionCursor(record execution.Record) string {
	body, _ := json.Marshal(executionCursor{ID: record.ID.String()})
	return base64.RawURLEncoding.EncodeToString(body)
}
