package postgres

import (
	"context"
	"database/sql"
	"errors"
	"strings"
	"time"

	"github.com/madebyduy/RhinoQ/internal/domain/taskschedule"
	"github.com/madebyduy/RhinoQ/internal/ports"
)

type TaskScheduleStore struct{ db *sql.DB }

const taskScheduleColumns = `id,tenant_id,task_name,owner_id,payload,every_ms,cron_expression,timezone,enabled,next_run_at,version,created_at,updated_at`

type taskScheduleScanner interface{ Scan(...any) error }

func scanTaskSchedule(row taskScheduleScanner) (taskschedule.Record, error) {
	var r taskschedule.Record
	var every sql.NullInt64
	var cron, timezone sql.NullString
	err := row.Scan(&r.ID, &r.TenantID, &r.TaskName, &r.OwnerID, &r.Payload, &every, &cron, &timezone, &r.Enabled, &r.NextRunAt, &r.Version, &r.CreatedAt, &r.UpdatedAt)
	if every.Valid {
		r.Every = time.Duration(every.Int64) * time.Millisecond
	}
	r.Cron, r.Timezone = cron.String, timezone.String
	return r, err
}

var _ ports.TaskScheduleStore = (*TaskScheduleStore)(nil)

func NewTaskScheduleStore(db *sql.DB) (*TaskScheduleStore, error) {
	if db == nil {
		return nil, errors.New("postgres database is required")
	}
	return &TaskScheduleStore{db: db}, nil
}

func (s *TaskScheduleStore) SaveTaskSchedule(ctx context.Context, record taskschedule.Record) (taskschedule.Record, error) {
	if err := record.Spec.Validate(); err != nil || record.Version < 1 || record.NextRunAt.IsZero() {
		return taskschedule.Record{}, taskschedule.ErrInvalid
	}
	_, err := s.db.ExecContext(ctx, `INSERT INTO rhinoq_task_schedules
		(id, tenant_id, task_name, owner_id, payload, every_ms, cron_expression, timezone, enabled, next_run_at, version, created_at, updated_at)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`, record.ID, record.TenantID, record.TaskName, record.OwnerID, []byte(record.Payload),
		nullableEvery(record.Every), scheduleNullableString(record.Cron), scheduleNullableString(record.Timezone), record.Enabled, record.NextRunAt, record.Version, record.CreatedAt, record.UpdatedAt)
	if err != nil {
		return taskschedule.Record{}, err
	}
	return record, nil
}

func (s *TaskScheduleStore) GetTaskSchedule(ctx context.Context, tenantID, id string) (taskschedule.Record, bool, error) {
	if strings.TrimSpace(tenantID) == "" || strings.TrimSpace(id) == "" {
		return taskschedule.Record{}, false, taskschedule.ErrInvalid
	}
	r, err := scanTaskSchedule(s.db.QueryRowContext(ctx, `SELECT `+taskScheduleColumns+` FROM rhinoq_task_schedules WHERE tenant_id=$1 AND id=$2`, tenantID, id))
	if errors.Is(err, sql.ErrNoRows) {
		return taskschedule.Record{}, false, nil
	}
	return r, err == nil, err
}

func (s *TaskScheduleStore) ListTaskSchedules(ctx context.Context, tenantID string, limit int) ([]taskschedule.Record, error) {
	if strings.TrimSpace(tenantID) == "" || limit < 1 || limit > 1000 {
		return nil, taskschedule.ErrInvalid
	}
	rows, err := s.db.QueryContext(ctx, `SELECT `+taskScheduleColumns+` FROM rhinoq_task_schedules WHERE tenant_id=$1 ORDER BY created_at,id LIMIT $2`, tenantID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := make([]taskschedule.Record, 0, limit)
	for rows.Next() {
		r, scanErr := scanTaskSchedule(rows)
		if scanErr != nil {
			return nil, scanErr
		}
		result = append(result, r)
	}
	return result, rows.Err()
}

func (s *TaskScheduleStore) SetTaskScheduleEnabled(ctx context.Context, tenantID, id string, version int64, enabled bool) (taskschedule.Record, error) {
	if strings.TrimSpace(tenantID) == "" || strings.TrimSpace(id) == "" || version < 1 {
		return taskschedule.Record{}, taskschedule.ErrInvalid
	}
	r, err := scanTaskSchedule(s.db.QueryRowContext(ctx, `UPDATE rhinoq_task_schedules SET enabled=$4,version=version+1,updated_at=clock_timestamp(),lease_owner=NULL,lease_expires_at=NULL WHERE tenant_id=$1 AND id=$2 AND version=$3 RETURNING `+taskScheduleColumns, tenantID, id, version, enabled))
	if errors.Is(err, sql.ErrNoRows) {
		return taskschedule.Record{}, ports.ErrVersionConflict
	}
	return r, err
}

func (s *TaskScheduleStore) UpdateTaskSchedule(ctx context.Context, tenantID, id string, version int64, every time.Duration, next time.Time) (taskschedule.Record, error) {
	if strings.TrimSpace(tenantID) == "" || strings.TrimSpace(id) == "" || version < 1 || every < taskschedule.MinimumInterval || every > taskschedule.MaximumInterval || next.IsZero() {
		return taskschedule.Record{}, taskschedule.ErrInvalid
	}
	r, err := scanTaskSchedule(s.db.QueryRowContext(ctx, `UPDATE rhinoq_task_schedules SET every_ms=$4,next_run_at=$5,version=version+1,updated_at=clock_timestamp(),lease_owner=NULL,lease_expires_at=NULL,last_error='' WHERE tenant_id=$1 AND id=$2 AND version=$3 RETURNING `+taskScheduleColumns, tenantID, id, version, every.Milliseconds(), next.UTC()))
	if errors.Is(err, sql.ErrNoRows) {
		return taskschedule.Record{}, ports.ErrVersionConflict
	}
	return r, err
}

func (s *TaskScheduleStore) UpdateTaskScheduleCalendar(ctx context.Context, tenantID, id string, version int64, expression, timezone string, next time.Time) (taskschedule.Record, error) {
	if strings.TrimSpace(tenantID) == "" || strings.TrimSpace(id) == "" || version < 1 || next.IsZero() { return taskschedule.Record{}, taskschedule.ErrInvalid }
	if _, err := taskschedule.ParseCron(expression, timezone); err != nil { return taskschedule.Record{}, err }
	r, err := scanTaskSchedule(s.db.QueryRowContext(ctx, `UPDATE rhinoq_task_schedules SET every_ms=NULL,cron_expression=$4,timezone=$5,next_run_at=$6,version=version+1,updated_at=clock_timestamp(),lease_owner=NULL,lease_expires_at=NULL,last_error='' WHERE tenant_id=$1 AND id=$2 AND version=$3 RETURNING `+taskScheduleColumns, tenantID, id, version, strings.Join(strings.Fields(expression), " "), strings.TrimSpace(timezone), next.UTC()))
	if errors.Is(err, sql.ErrNoRows) { return taskschedule.Record{}, ports.ErrVersionConflict }
	return r, err
}

func (s *TaskScheduleStore) DeleteTaskSchedule(ctx context.Context, tenantID, id string, version int64) error {
	if strings.TrimSpace(tenantID) == "" || strings.TrimSpace(id) == "" || version < 1 {
		return taskschedule.ErrInvalid
	}
	result, err := s.db.ExecContext(ctx, `DELETE FROM rhinoq_task_schedules WHERE tenant_id=$1 AND id=$2 AND version=$3`, tenantID, id, version)
	if err != nil {
		return err
	}
	n, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if n != 1 {
		return ports.ErrVersionConflict
	}
	return nil
}

func (s *TaskScheduleStore) TaskScheduleStats(ctx context.Context) (taskschedule.Stats, error) {
	var stats taskschedule.Stats
	var lagMS int64
	err := s.db.QueryRowContext(ctx, `SELECT
		count(*) FILTER (WHERE enabled), count(*) FILTER (WHERE NOT enabled),
		count(*) FILTER (WHERE enabled AND next_run_at<=clock_timestamp()),
		count(*) FILTER (WHERE lease_expires_at>clock_timestamp()),
		count(*) FILTER (WHERE last_error<>''),
		coalesce(greatest(0,extract(epoch FROM (clock_timestamp()-min(next_run_at) FILTER (WHERE enabled AND next_run_at<=clock_timestamp())))*1000),0)::bigint
		FROM rhinoq_task_schedules`).Scan(&stats.Enabled, &stats.Paused, &stats.Due, &stats.Leased, &stats.Failed, &lagMS)
	stats.OldestDueLag = time.Duration(lagMS) * time.Millisecond
	return stats, err
}

func (s *TaskScheduleStore) ClaimDueTaskSchedules(ctx context.Context, owner string, now time.Time, leaseFor time.Duration, limit int) ([]taskschedule.Lease, error) {
	if strings.TrimSpace(owner) == "" || now.IsZero() || leaseFor <= 0 || limit < 1 || limit > 100 {
		return nil, taskschedule.ErrInvalid
	}
	rows, err := s.db.QueryContext(ctx, `WITH due AS (
		SELECT id, tenant_id FROM rhinoq_task_schedules
		WHERE enabled AND next_run_at <= clock_timestamp()
		  AND (lease_expires_at IS NULL OR lease_expires_at <= clock_timestamp())
		ORDER BY next_run_at,id FOR UPDATE SKIP LOCKED LIMIT $1)
		UPDATE rhinoq_task_schedules s SET lease_owner=$2, lease_epoch=s.lease_epoch+1,
		 lease_expires_at=clock_timestamp()+$3::interval, last_started_at=clock_timestamp(), last_error='', updated_at=clock_timestamp()
		FROM due WHERE s.id=due.id AND s.tenant_id=due.tenant_id
		RETURNING s.id,s.tenant_id,s.task_name,s.owner_id,s.payload,s.next_run_at,s.every_ms,s.cron_expression,s.timezone,s.lease_epoch,s.lease_expires_at`, limit, owner, postgresInterval(leaseFor))
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := make([]taskschedule.Lease, 0, limit)
	for rows.Next() {
		var l taskschedule.Lease
		var every sql.NullInt64
		var cron, timezone sql.NullString
		if err := rows.Scan(&l.ScheduleID, &l.TenantID, &l.TaskName, &l.OwnerID, &l.Payload, &l.Occurrence, &every, &cron, &timezone, &l.Epoch, &l.ExpiresAt); err != nil {
			return nil, err
		}
		l.LeaseOwner = owner
		if every.Valid {
			l.Every = time.Duration(every.Int64) * time.Millisecond
		}
		l.Cron, l.Timezone = cron.String, timezone.String
		if err := l.Validate(); err != nil {
			return nil, err
		}
		result = append(result, l)
	}
	return result, rows.Err()
}

func (s *TaskScheduleStore) CompleteTaskSchedule(ctx context.Context, lease taskschedule.Lease, next time.Time) error {
	if err := lease.Validate(); err != nil || next.IsZero() {
		return err
	}
	return taskScheduleUpdate(s.db.ExecContext(ctx, `UPDATE rhinoq_task_schedules SET
		next_run_at=$4, lease_owner=NULL, lease_expires_at=NULL,
		last_completed_at=clock_timestamp(),last_error='',updated_at=clock_timestamp(),version=version+1
		WHERE id=$1 AND tenant_id=$5 AND lease_owner=$2 AND lease_epoch=$3`, lease.ScheduleID, lease.LeaseOwner, lease.Epoch, next.UTC(), lease.TenantID))
}

func nullableEvery(value time.Duration) any {
	if value == 0 {
		return nil
	}
	return value.Milliseconds()
}
func scheduleNullableString(value string) any {
	if strings.TrimSpace(value) == "" {
		return nil
	}
	return strings.TrimSpace(value)
}

func (s *TaskScheduleStore) FailTaskSchedule(ctx context.Context, lease taskschedule.Lease, retryAfter time.Duration, message string) error {
	if err := lease.Validate(); err != nil || retryAfter <= 0 {
		return taskschedule.ErrInvalid
	}
	if len(message) > 4096 {
		message = message[:4096]
	}
	return taskScheduleUpdate(s.db.ExecContext(ctx, `UPDATE rhinoq_task_schedules SET
		lease_expires_at=clock_timestamp()+$4::interval,last_error=$5,updated_at=clock_timestamp()
		WHERE id=$1 AND tenant_id=$6 AND lease_owner=$2 AND lease_epoch=$3`, lease.ScheduleID, lease.LeaseOwner, lease.Epoch, postgresInterval(retryAfter), message, lease.TenantID))
}

func taskScheduleUpdate(result sql.Result, err error) error {
	if err != nil {
		return err
	}
	affected, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if affected != 1 {
		return ports.ErrLeaseLost
	}
	return nil
}
