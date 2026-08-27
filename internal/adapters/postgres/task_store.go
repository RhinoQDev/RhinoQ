package postgres

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/madebyduy/RhinoQ/internal/domain/correlation"
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

func (s *TaskStore) CreateWaitpoint(ctx context.Context, record waitpoint.Record) (waitpoint.Record, bool, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return waitpoint.Record{}, false, err
	}
	defer func() { _ = tx.Rollback() }()
	result, err := tx.ExecContext(ctx, `INSERT INTO rhinoq_task_waitpoints
		(id,task_id,key,kind,schema_version,state,deadline,version,created_at,updated_at)
		VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT DO NOTHING`,
		record.ID, record.TaskID, record.Key, record.Kind, record.SchemaVersion, record.State,
		waitpointNullableTime(record.Deadline), record.Version, record.CreatedAt, record.UpdatedAt)
	if err != nil {
		return waitpoint.Record{}, false, err
	}
	rows, err := result.RowsAffected()
	if err != nil {
		return waitpoint.Record{}, false, err
	}
	if rows == 1 {
		if _, err = tx.ExecContext(ctx, `UPDATE rhinoq_tasks SET version=version+1,updated_at=GREATEST(updated_at,$2) WHERE id=$1`, record.TaskID, record.UpdatedAt); err != nil {
			return waitpoint.Record{}, false, err
		}
		if err = tx.Commit(); err != nil {
			return waitpoint.Record{}, false, err
		}
		return record, false, nil
	}
	if err = tx.Rollback(); err != nil {
		return waitpoint.Record{}, false, err
	}
	prior, found, err := s.GetTaskWaitpoint(ctx, record.TaskID, record.Key)
	if err != nil {
		return waitpoint.Record{}, false, err
	}
	if !found || prior.ID != record.ID || prior.Kind != record.Kind || prior.SchemaVersion != record.SchemaVersion || !prior.Deadline.Equal(record.Deadline) {
		return waitpoint.Record{}, false, ports.ErrWaitpointConflict
	}
	return prior, true, nil
}

func (s *TaskStore) GetWaitpoint(ctx context.Context, id waitpoint.ID) (waitpoint.Record, bool, error) {
	r, err := scanWaitpoint(s.db.QueryRowContext(ctx, waitpointSelect+` WHERE id=$1`, id))
	if errors.Is(err, sql.ErrNoRows) {
		return waitpoint.Record{}, false, nil
	}
	return r, err == nil, err
}

func (s *TaskStore) GetTaskWaitpoint(ctx context.Context, taskID, key string) (waitpoint.Record, bool, error) {
	r, err := scanWaitpoint(s.db.QueryRowContext(ctx, waitpointSelect+` WHERE task_id=$1 AND key=$2`, taskID, key))
	if errors.Is(err, sql.ErrNoRows) {
		return waitpoint.Record{}, false, nil
	}
	return r, err == nil, err
}

func (s *TaskStore) UpdateWaitpoint(ctx context.Context, record waitpoint.Record, expectedVersion int64) (waitpoint.Record, error) {
	if expectedVersion <= 0 || (record.Version != expectedVersion && record.Version != expectedVersion+1) {
		return waitpoint.Record{}, ports.ErrVersionConflict
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return waitpoint.Record{}, err
	}
	defer func() { _ = tx.Rollback() }()
	result, err := tx.ExecContext(ctx, `UPDATE rhinoq_task_waitpoints SET state=$2,resolution=$3::jsonb,resolution_hash=$4,
		resolution_id=$5,resolved_by=$6,resolved_at=$7,version=$8,updated_at=$9 WHERE id=$1 AND version=$10`,
		record.ID, record.State, waitpointNullableJSON(record.Resolution), nullableString(record.ResolutionHash), nullableString(record.ResolutionID),
		nullableString(record.ResolvedBy), waitpointNullableTime(record.ResolvedAt), record.Version, record.UpdatedAt, expectedVersion)
	if err != nil {
		return waitpoint.Record{}, mapWaitpointConflict(err)
	}
	rows, err := result.RowsAffected()
	if err != nil {
		return waitpoint.Record{}, err
	}
	if rows == 0 {
		if _, found, getErr := s.GetWaitpoint(ctx, record.ID); getErr != nil {
			return waitpoint.Record{}, getErr
		} else if !found {
			return waitpoint.Record{}, ports.ErrWaitpointNotFound
		}
		return waitpoint.Record{}, ports.ErrVersionConflict
	}
	if _, err = tx.ExecContext(ctx, `UPDATE rhinoq_tasks SET version=version+1,updated_at=GREATEST(updated_at,$2) WHERE id=$1`, record.TaskID, record.UpdatedAt); err != nil {
		return waitpoint.Record{}, err
	}
	if record.State == waitpoint.Resolved {
		payload, marshalErr := json.Marshal(map[string]any{"schemaVersion": 1, "waitpointId": record.ID, "taskId": record.TaskID, "key": record.Key, "kind": record.Kind, "resolutionId": record.ResolutionID})
		if marshalErr != nil {
			return waitpoint.Record{}, marshalErr
		}
		if _, err = tx.ExecContext(ctx, `INSERT INTO rhinoq_outbox(aggregate_type,aggregate_id,event_type,payload) VALUES('task_waitpoint',$1,'task.waitpoint.resolved',$2::jsonb)`, record.ID, payload); err != nil {
			return waitpoint.Record{}, err
		}
	}
	if err = tx.Commit(); err != nil {
		return waitpoint.Record{}, err
	}
	return record, nil
}

func (s *TaskStore) ListDueWaitpoints(ctx context.Context, now time.Time, limit int) ([]waitpoint.Record, error) {
	if now.IsZero() || limit <= 0 {
		return nil, errors.New("time and positive limit are required")
	}
	rows, err := s.db.QueryContext(ctx, waitpointSelect+` WHERE state='waiting' AND deadline IS NOT NULL AND deadline <= $1 ORDER BY deadline,id LIMIT $2`, now, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := make([]waitpoint.Record, 0, limit)
	for rows.Next() {
		r, scanErr := scanWaitpoint(rows)
		if scanErr != nil {
			return nil, scanErr
		}
		result = append(result, r)
	}
	return result, rows.Err()
}

func (s *TaskStore) RetryTask(ctx context.Context, input ports.TaskRetryInput) (ports.TaskRetryResult, error) {
	if strings.TrimSpace(input.CommandID) == "" || input.TaskID == "" || input.ExecutionID == "" ||
		strings.TrimSpace(input.Runtime) == "" || strings.TrimSpace(input.Queue) == "" ||
		strings.TrimSpace(input.JobName) == "" || len(input.Payload) == 0 || !json.Valid(input.Payload) ||
		input.ExpectedVersion <= 0 || input.Now.IsZero() {
		return ports.TaskRetryResult{}, errors.New("valid retry command, task, execution, runtime, queue, job, JSON payload, version and time are required")
	}
	fingerprintBytes := sha256.Sum256([]byte(strings.Join([]string{
		strings.TrimSpace(input.Runtime), strings.TrimSpace(input.Queue), strings.TrimSpace(input.JobName), string(input.Payload),
	}, "\x00")))
	fingerprint := hex.EncodeToString(fingerprintBytes[:])
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return ports.TaskRetryResult{}, err
	}
	defer func() { _ = tx.Rollback() }()
	// Serialize identical identities before the existence check. A concurrent
	// duplicate then observes the first commit instead of surfacing a transient
	// unique violation that tempts callers to invent a second command id.
	if _, err = tx.ExecContext(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, input.CommandID); err != nil {
		return ports.TaskRetryResult{}, err
	}

	var storedTaskID, storedExecutionID, storedFingerprint string
	err = tx.QueryRowContext(ctx, `SELECT task_id, execution_id, dispatch_fingerprint FROM rhinoq_task_retry_commands WHERE command_id=$1`, input.CommandID).Scan(&storedTaskID, &storedExecutionID, &storedFingerprint)
	if err == nil {
		if storedTaskID != input.TaskID.String() || storedExecutionID != input.ExecutionID.String() || storedFingerprint != fingerprint {
			return ports.TaskRetryResult{}, fmt.Errorf("%w: retry command identity reused with different input", ports.ErrAlreadyExists)
		}
		taskRecord, scanErr := scanTask(tx.QueryRowContext(ctx, taskSelect+` WHERE id=$1`, storedTaskID))
		if scanErr != nil {
			return ports.TaskRetryResult{}, scanErr
		}
		executionRecord, scanErr := scanExecution(tx.QueryRowContext(ctx, executionSelect+` WHERE id=$1`, storedExecutionID))
		if scanErr != nil {
			return ports.TaskRetryResult{}, scanErr
		}
		return ports.TaskRetryResult{Task: taskRecord, Execution: executionRecord, Replayed: true}, nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return ports.TaskRetryResult{}, err
	}

	current, err := scanTask(tx.QueryRowContext(ctx, taskSelect+` WHERE id=$1 FOR UPDATE`, input.TaskID))
	if errors.Is(err, sql.ErrNoRows) {
		return ports.TaskRetryResult{}, ports.ErrTaskNotFound
	}
	if err != nil {
		return ports.TaskRetryResult{}, err
	}
	if current.Version != input.ExpectedVersion {
		return ports.TaskRetryResult{}, ports.ErrVersionConflict
	}
	next, err := current.Transition(task.Queued, input.Now)
	if err != nil {
		return ports.TaskRetryResult{}, err
	}
	var attempt int
	if err := tx.QueryRowContext(ctx, `SELECT COALESCE(MAX(attempt),0)+1 FROM rhinoq_task_executions WHERE task_id=$1`, input.TaskID).Scan(&attempt); err != nil {
		return ports.TaskRetryResult{}, err
	}
	executionRecord, err := execution.NewRecord(execution.Spec{ID: input.ExecutionID, TaskID: input.TaskID.String(), Attempt: attempt, Runtime: strings.TrimSpace(input.Runtime), Trace: input.Trace, Now: input.Now})
	if err != nil {
		return ports.TaskRetryResult{}, err
	}
	retryTraceID, retrySpanID, retryFlags, retryState := traceColumns(executionRecord.Trace)
	if _, err = tx.ExecContext(ctx, `INSERT INTO rhinoq_task_executions (id,task_id,attempt,runtime,job_id,external_id,state,trace_id,trace_span_id,trace_flags,trace_state,version,created_at,updated_at) VALUES ($1,$2,$3,$4,NULL,NULL,$5,$6,$7,$8,$9,$10,$11,$12)`, executionRecord.ID, executionRecord.TaskID, executionRecord.Attempt, executionRecord.Runtime, executionRecord.State, retryTraceID, retrySpanID, retryFlags, retryState, executionRecord.Version, executionRecord.CreatedAt, executionRecord.UpdatedAt); err != nil {
		return ports.TaskRetryResult{}, mapAlreadyExists(err)
	}
	next.ExecutionCounts.Total++
	next.ExecutionCounts.PendingDispatch++
	if _, err = tx.ExecContext(ctx, `UPDATE rhinoq_tasks SET state=$2,cancellation_status=$3,cancellation_reason=$4,execution_total=$5,execution_pending_dispatch=$6,version=$7,updated_at=$8 WHERE id=$1 AND version=$9`, next.ID, next.State, next.CancellationStatus, nullableString(next.CancellationReason), next.ExecutionCounts.Total, next.ExecutionCounts.PendingDispatch, next.Version, next.UpdatedAt, input.ExpectedVersion); err != nil {
		return ports.TaskRetryResult{}, err
	}
	if _, err = tx.ExecContext(ctx, `INSERT INTO rhinoq_task_retry_commands(command_id,task_id,execution_id,dispatch_fingerprint,expected_version,created_at) VALUES($1,$2,$3,$4,$5,$6)`, input.CommandID, input.TaskID, input.ExecutionID, fingerprint, input.ExpectedVersion, input.Now); err != nil {
		return ports.TaskRetryResult{}, mapAlreadyExists(err)
	}
	payload, err := json.Marshal(map[string]any{"schemaVersion": 1, "commandId": input.CommandID, "taskId": input.TaskID, "executionId": input.ExecutionID, "runtime": executionRecord.Runtime, "queue": strings.TrimSpace(input.Queue), "jobName": strings.TrimSpace(input.JobName), "data": json.RawMessage(input.Payload), "attempt": executionRecord.Attempt})
	if err != nil {
		return ports.TaskRetryResult{}, err
	}
	if _, err = tx.ExecContext(ctx, `INSERT INTO rhinoq_outbox(aggregate_type,aggregate_id,event_type,payload) VALUES('task',$1,'task.retry.dispatch_requested',$2::jsonb)`, input.TaskID, payload); err != nil {
		return ports.TaskRetryResult{}, err
	}
	if err = tx.Commit(); err != nil {
		return ports.TaskRetryResult{}, err
	}
	return ports.TaskRetryResult{Task: next, Execution: executionRecord}, nil
}

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
	traceID, traceSpanID, traceFlags, traceState := traceColumns(record.Trace)
	if _, err := tx.ExecContext(ctx, `
		INSERT INTO rhinoq_task_executions (
			id, task_id, attempt, runtime, job_id, external_id,
			state, trace_id, trace_span_id, trace_flags, trace_state,
			version, created_at, updated_at
		) VALUES ($1,$2,$3,$4,NULL,NULL,$5,$6,$7,$8,$9,$10,$11,$12)`,
		record.ID, record.TaskID, record.Attempt, record.Runtime,
		record.State, traceID, traceSpanID, traceFlags, traceState,
		record.Version, record.CreatedAt, record.UpdatedAt); err != nil {
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
	COALESCE(result_ref,''), COALESCE(failure_reason,''),
	COALESCE(trace_id,''), COALESCE(trace_span_id,''),
	COALESCE(trace_flags,''), COALESCE(trace_state,''), version,
	created_at, updated_at FROM rhinoq_task_executions`

func scanExecution(row rowScanner) (execution.Record, error) {
	var record execution.Record
	err := row.Scan(&record.ID, &record.TaskID, &record.Attempt, &record.Runtime,
		&record.Reference.JobID, &record.Reference.ExternalID, &record.State,
		&record.ResultRef, &record.FailureReason,
		&record.Trace.TraceID, &record.Trace.SpanID,
		&record.Trace.Flags, &record.Trace.TraceState,
		&record.Version, &record.CreatedAt, &record.UpdatedAt)
	if err != nil {
		return execution.Record{}, err
	}
	record.Reference.Runtime = record.Runtime
	return record, nil
}

// traceColumns renders the four trace values as insert arguments. NULL rather
// than empty string is what the schema's shape constraint is written against,
// and it is also the honest encoding: an execution with no inbound request has
// no trace, as opposed to one whose trace is the empty string.
func traceColumns(trace correlation.TraceContext) (any, any, any, any) {
	if trace.Zero() {
		return nil, nil, nil, nil
	}
	flags := trace.Flags
	if flags == "" {
		flags = "00"
	}
	return trace.TraceID, trace.SpanID, flags, nullableString(trace.TraceState)
}

const waitpointSelect = `SELECT id,task_id,key,kind,schema_version,state,deadline,
	resolution,resolution_hash,resolution_id,resolved_by,resolved_at,version,created_at,updated_at
	FROM rhinoq_task_waitpoints`

func scanWaitpoint(row rowScanner) (waitpoint.Record, error) {
	var r waitpoint.Record
	var deadline, resolvedAt sql.NullTime
	var resolution []byte
	var hash, resolutionID, resolvedBy sql.NullString
	err := row.Scan(&r.ID, &r.TaskID, &r.Key, &r.Kind, &r.SchemaVersion, &r.State, &deadline,
		&resolution, &hash, &resolutionID, &resolvedBy, &resolvedAt, &r.Version, &r.CreatedAt, &r.UpdatedAt)
	if err != nil {
		return waitpoint.Record{}, err
	}
	if deadline.Valid {
		r.Deadline = deadline.Time
	}
	if resolvedAt.Valid {
		r.ResolvedAt = resolvedAt.Time
	}
	r.Resolution, r.ResolutionHash, r.ResolutionID, r.ResolvedBy = resolution, hash.String, resolutionID.String, resolvedBy.String
	return r, nil
}

func waitpointNullableTime(value time.Time) any {
	if value.IsZero() {
		return nil
	}
	return value
}
func waitpointNullableJSON(value []byte) any {
	if len(value) == 0 {
		return nil
	}
	return string(value)
}

func mapWaitpointConflict(err error) error {
	var state sqlStateError
	if errors.As(err, &state) && state.SQLState() == "23505" {
		return fmt.Errorf("%w: %v", ports.ErrWaitpointConflict, err)
	}
	return err
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
