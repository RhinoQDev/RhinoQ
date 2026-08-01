package postgres

import (
	"context"
	"database/sql"
	"errors"
	"fmt"

	"github.com/madebyduy/RhinoQ/internal/domain/execution"
	"github.com/madebyduy/RhinoQ/internal/domain/task"
	"github.com/madebyduy/RhinoQ/internal/ports"
)

var (
	_ ports.TaskStore      = (*TaskStore)(nil)
	_ ports.ExecutionStore = (*TaskStore)(nil)
)

type TaskStore struct{ db *sql.DB }

func NewTaskStore(db *sql.DB) (*TaskStore, error) {
	if db == nil {
		return nil, errors.New("postgres database is required")
	}
	return &TaskStore{db: db}, nil
}

func (s *TaskStore) CreateTask(ctx context.Context, record task.Record) (task.Record, error) {
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO rhinoq_tasks (
			id, type, owner_id, definition_version, state,
			progress_completed, progress_total, progress_message, result_ref,
			cancellation_status, cancellation_reason,
			version, created_at, updated_at
		) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
		record.ID, record.Type, nullableString(record.OwnerID), record.DefinitionVersion,
		record.State, record.Progress.Completed, nullableProgressTotal(record.Progress),
		nullableString(record.Progress.Message), nullableString(record.ResultRef),
		record.CancellationStatus, nullableString(record.CancellationReason),
		record.Version, record.CreatedAt, record.UpdatedAt)
	if err != nil {
		return task.Record{}, mapAlreadyExists(err)
	}
	return record, nil
}

func (s *TaskStore) GetTask(ctx context.Context, id task.ID) (task.Record, bool, error) {
	record, err := scanTask(s.db.QueryRowContext(ctx, taskSelect+` WHERE id = $1`, id))
	if errors.Is(err, sql.ErrNoRows) {
		return task.Record{}, false, nil
	}
	return record, err == nil, err
}

func (s *TaskStore) UpdateTask(ctx context.Context, record task.Record, expectedVersion int64) (task.Record, error) {
	if expectedVersion <= 0 || record.Version != expectedVersion+1 {
		return task.Record{}, ports.ErrVersionConflict
	}
	result, err := s.db.ExecContext(ctx, `
		UPDATE rhinoq_tasks SET
			type=$2, owner_id=$3, definition_version=$4, state=$5,
			progress_completed=$6, progress_total=$7, progress_message=$8,
			result_ref=$9, cancellation_status=$10, cancellation_reason=$11,
			version=$12, updated_at=$13
		WHERE id=$1 AND version=$14`,
		record.ID, record.Type, nullableString(record.OwnerID), record.DefinitionVersion,
		record.State, record.Progress.Completed, nullableProgressTotal(record.Progress),
		nullableString(record.Progress.Message), nullableString(record.ResultRef),
		record.CancellationStatus, nullableString(record.CancellationReason),
		record.Version, record.UpdatedAt, expectedVersion)
	if err != nil {
		return task.Record{}, err
	}
	rows, err := result.RowsAffected()
	if err != nil {
		return task.Record{}, err
	}
	if rows == 0 {
		if _, found, getErr := s.GetTask(ctx, record.ID); getErr != nil {
			return task.Record{}, getErr
		} else if !found {
			return task.Record{}, ports.ErrTaskNotFound
		}
		return task.Record{}, ports.ErrVersionConflict
	}
	return record, nil
}

func (s *TaskStore) CreateNextExecution(ctx context.Context, input ports.ExecutionCreateInput) (execution.Record, int64, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return execution.Record{}, 0, err
	}
	defer func() { _ = tx.Rollback() }()
	var exists bool
	if err := tx.QueryRowContext(ctx, `
		SELECT true FROM rhinoq_tasks WHERE id=$1 FOR UPDATE`, input.TaskID).Scan(&exists); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return execution.Record{}, 0, ports.ErrTaskNotFound
		}
		return execution.Record{}, 0, err
	}
	var attempt int
	if err := tx.QueryRowContext(ctx, `
		SELECT COALESCE(MAX(attempt), 0) + 1
		FROM rhinoq_task_executions WHERE task_id=$1`, input.TaskID).Scan(&attempt); err != nil {
		return execution.Record{}, 0, err
	}
	record, err := execution.NewRecord(execution.Spec{
		ID: input.ID, TaskID: input.TaskID, Attempt: attempt,
		Runtime: input.Runtime, Now: input.Now,
	})
	if err != nil {
		return execution.Record{}, 0, err
	}
	if _, err := tx.ExecContext(ctx, `
		INSERT INTO rhinoq_task_executions (
			id, task_id, attempt, runtime, job_id, external_id,
			state, version, created_at, updated_at
		) VALUES ($1,$2,$3,$4,NULL,NULL,$5,$6,$7,$8)`,
		record.ID, record.TaskID, record.Attempt, record.Runtime,
		record.State, record.Version, record.CreatedAt, record.UpdatedAt); err != nil {
		return execution.Record{}, 0, mapAlreadyExists(err)
	}
	var taskVersion int64
	if err := tx.QueryRowContext(ctx, `
		UPDATE rhinoq_tasks
		SET execution_total=execution_total+1,
			execution_pending_dispatch=execution_pending_dispatch+1,
			version=version+1, updated_at=GREATEST(updated_at, $2)
		WHERE id=$1
		RETURNING version`, input.TaskID, input.Now).Scan(&taskVersion); err != nil {
		return execution.Record{}, 0, err
	}
	if err := tx.Commit(); err != nil {
		return execution.Record{}, 0, err
	}
	return record, taskVersion, nil
}

func (s *TaskStore) GetExecution(ctx context.Context, id execution.ID) (execution.Record, bool, error) {
	record, err := scanExecution(s.db.QueryRowContext(ctx, executionSelect+` WHERE id=$1`, id))
	if errors.Is(err, sql.ErrNoRows) {
		return execution.Record{}, false, nil
	}
	return record, err == nil, err
}

func (s *TaskStore) FindExecutionByExternalReference(
	ctx context.Context,
	runtime, externalID string,
) (execution.Record, bool, error) {
	record, err := scanExecution(s.db.QueryRowContext(ctx, executionSelect+`
		WHERE runtime=$1 AND external_id=$2`, runtime, externalID))
	if errors.Is(err, sql.ErrNoRows) {
		return execution.Record{}, false, nil
	}
	return record, err == nil, err
}

func (s *TaskStore) UpdateExecution(ctx context.Context, record execution.Record, expectedVersion int64) (execution.Record, int64, error) {
	if expectedVersion <= 0 || record.Version != expectedVersion+1 {
		return execution.Record{}, 0, ports.ErrVersionConflict
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return execution.Record{}, 0, err
	}
	defer func() { _ = tx.Rollback() }()
	var currentState execution.State
	var currentVersion int64
	if err := tx.QueryRowContext(ctx, `
		SELECT state, version FROM rhinoq_task_executions
		WHERE id=$1 FOR UPDATE`, record.ID).Scan(&currentState, &currentVersion); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return execution.Record{}, 0, ports.ErrExecutionNotFound
		}
		return execution.Record{}, 0, err
	}
	if currentVersion != expectedVersion {
		return execution.Record{}, 0, ports.ErrVersionConflict
	}
	result, err := tx.ExecContext(ctx, `
		UPDATE rhinoq_task_executions SET
			runtime=$2, job_id=$3, external_id=$4, state=$5,
			result_ref=$6, failure_reason=$7, version=$8, updated_at=$9
		WHERE id=$1 AND task_id=$10 AND attempt=$11 AND version=$12`,
		record.ID, record.Runtime, nullableString(record.Reference.JobID),
		nullableString(record.Reference.ExternalID), record.State,
		nullableString(record.ResultRef), nullableString(record.FailureReason),
		record.Version, record.UpdatedAt, record.TaskID, record.Attempt, expectedVersion)
	if err != nil {
		return execution.Record{}, 0, err
	}
	rows, err := result.RowsAffected()
	if err != nil {
		return execution.Record{}, 0, err
	}
	if rows == 0 {
		_, getErr := scanExecution(tx.QueryRowContext(ctx, executionSelect+` WHERE id=$1`, record.ID))
		if errors.Is(getErr, sql.ErrNoRows) {
			return execution.Record{}, 0, ports.ErrExecutionNotFound
		}
		if getErr != nil {
			return execution.Record{}, 0, getErr
		}
		return execution.Record{}, 0, ports.ErrVersionConflict
	}
	var taskVersion int64
	if err := tx.QueryRowContext(ctx, `
		UPDATE rhinoq_tasks
		SET execution_pending_dispatch=execution_pending_dispatch+
			(CASE WHEN $3='pending_dispatch' THEN -1 ELSE 0 END)+
			(CASE WHEN $4='pending_dispatch' THEN 1 ELSE 0 END),
			execution_dispatched=execution_dispatched+
			(CASE WHEN $3='dispatched' THEN -1 ELSE 0 END)+
			(CASE WHEN $4='dispatched' THEN 1 ELSE 0 END),
			execution_running=execution_running+
			(CASE WHEN $3='running' THEN -1 ELSE 0 END)+
			(CASE WHEN $4='running' THEN 1 ELSE 0 END),
			execution_succeeded=execution_succeeded+
			(CASE WHEN $3='succeeded' THEN -1 ELSE 0 END)+
			(CASE WHEN $4='succeeded' THEN 1 ELSE 0 END),
			execution_failed=execution_failed+
			(CASE WHEN $3='failed' THEN -1 ELSE 0 END)+
			(CASE WHEN $4='failed' THEN 1 ELSE 0 END),
			execution_stalled=execution_stalled+
			(CASE WHEN $3='stalled' THEN -1 ELSE 0 END)+
			(CASE WHEN $4='stalled' THEN 1 ELSE 0 END),
			execution_cancelled=execution_cancelled+
			(CASE WHEN $3='cancelled' THEN -1 ELSE 0 END)+
			(CASE WHEN $4='cancelled' THEN 1 ELSE 0 END),
			version=version+1, updated_at=GREATEST(updated_at, $2)
		WHERE id=$1
		RETURNING version`, record.TaskID, record.UpdatedAt, currentState, record.State).Scan(&taskVersion); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return execution.Record{}, 0, ports.ErrTaskNotFound
		}
		return execution.Record{}, 0, err
	}
	if err := tx.Commit(); err != nil {
		return execution.Record{}, 0, err
	}
	return record, taskVersion, nil
}

func (s *TaskStore) ListTaskExecutions(ctx context.Context, taskID string) ([]execution.Record, error) {
	rows, err := s.db.QueryContext(ctx, executionSelect+`
		WHERE task_id=$1 ORDER BY attempt, id`, taskID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	records := make([]execution.Record, 0)
	for rows.Next() {
		record, err := scanExecution(rows)
		if err != nil {
			return nil, err
		}
		records = append(records, record)
	}
	return records, rows.Err()
}

func (s *TaskStore) ListTaskExecutionsPage(ctx context.Context, query ports.ExecutionPageQuery) ([]execution.Record, bool, error) {
	if query.TaskID == "" || query.Limit <= 0 {
		return nil, false, errors.New("task id and positive page limit are required")
	}
	rows, err := s.db.QueryContext(ctx, executionSelect+`
		WHERE task_id=$1
		  AND ($2::text = '' OR (created_at, id) > (
		      SELECT created_at, id FROM rhinoq_task_executions
		      WHERE task_id=$1 AND id=$2
		  ))
		ORDER BY created_at, id LIMIT $3`, query.TaskID, query.AfterID, query.Limit+1)
	if err != nil {
		return nil, false, err
	}
	defer rows.Close()
	records := make([]execution.Record, 0, query.Limit+1)
	for rows.Next() {
		record, err := scanExecution(rows)
		if err != nil {
			return nil, false, err
		}
		records = append(records, record)
	}
	if err := rows.Err(); err != nil {
		return nil, false, err
	}
	more := len(records) > query.Limit
	if more {
		records = records[:query.Limit]
	}
	return records, more, nil
}

const taskSelect = `SELECT id, type, COALESCE(owner_id,''), definition_version,
	state, progress_completed, progress_total, COALESCE(progress_message,''),
	COALESCE(result_ref,''), cancellation_status,
	COALESCE(cancellation_reason,''), execution_total,
	execution_pending_dispatch, execution_dispatched, execution_running,
	execution_succeeded, execution_failed, execution_stalled, execution_cancelled,
	version, created_at, updated_at
	FROM rhinoq_tasks`

type rowScanner interface{ Scan(...any) error }

func scanTask(row rowScanner) (task.Record, error) {
	var record task.Record
	var total sql.NullInt64
	err := row.Scan(&record.ID, &record.Type, &record.OwnerID, &record.DefinitionVersion,
		&record.State, &record.Progress.Completed, &total, &record.Progress.Message,
		&record.ResultRef, &record.CancellationStatus, &record.CancellationReason,
		&record.ExecutionCounts.Total, &record.ExecutionCounts.PendingDispatch,
		&record.ExecutionCounts.Dispatched, &record.ExecutionCounts.Running,
		&record.ExecutionCounts.Succeeded, &record.ExecutionCounts.Failed,
		&record.ExecutionCounts.Stalled, &record.ExecutionCounts.Cancelled,
		&record.Version, &record.CreatedAt, &record.UpdatedAt)
	if err != nil {
		return task.Record{}, err
	}
	if total.Valid {
		record.Progress.HasTotal = true
		record.Progress.Total = total.Int64
	}
	return record, nil
}

const executionSelect = `SELECT id, task_id, attempt, runtime,
	COALESCE(job_id,''), COALESCE(external_id,''), state,
	COALESCE(result_ref,''), COALESCE(failure_reason,''), version,
	created_at, updated_at FROM rhinoq_task_executions`

func scanExecution(row rowScanner) (execution.Record, error) {
	var record execution.Record
	err := row.Scan(&record.ID, &record.TaskID, &record.Attempt, &record.Runtime,
		&record.Reference.JobID, &record.Reference.ExternalID, &record.State,
		&record.ResultRef, &record.FailureReason,
		&record.Version, &record.CreatedAt, &record.UpdatedAt)
	if err != nil {
		return execution.Record{}, err
	}
	record.Reference.Runtime = record.Runtime
	return record, nil
}

func nullableProgressTotal(progress task.Progress) any {
	if !progress.HasTotal {
		return nil
	}
	return progress.Total
}

type sqlStateError interface{ SQLState() string }

func mapAlreadyExists(err error) error {
	var state sqlStateError
	if errors.As(err, &state) && state.SQLState() == "23505" {
		return fmt.Errorf("%w: %v", ports.ErrAlreadyExists, err)
	}
	return err
}
