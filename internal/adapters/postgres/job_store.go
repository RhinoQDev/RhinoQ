package postgres

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/rhinoq/rhinoq/internal/domain/job"
	"github.com/rhinoq/rhinoq/internal/ports"
)

var (
	ErrLeaseLost = errors.New("job lease is no longer authoritative")
	ErrNotFound  = errors.New("job not found")
)

type JobStore struct {
	db *sql.DB
}

func NewJobStore(db *sql.DB) (*JobStore, error) {
	if db == nil {
		return nil, errors.New("postgres database is required")
	}
	return &JobStore{db: db}, nil
}

func (s *JobStore) Enqueue(ctx context.Context, input ports.EnqueueInput) (ports.JobID, error) {
	id, err := newID("job")
	if err != nil {
		return "", err
	}
	var storedID string
	var idempotency any
	if input.IdempotencyKey != "" {
		idempotency = input.IdempotencyKey
	}
	notBefore := input.NotBefore
	if notBefore.IsZero() {
		notBefore = time.Now().UTC()
	}
	err = s.db.QueryRowContext(ctx, `
		INSERT INTO rhinoq_jobs
			(id, name, payload, state, idempotency_key, correlation_id, not_before)
		VALUES ($1, $2, $3, 'pending', $4, $5, $6)
		ON CONFLICT (name, idempotency_key)
		DO UPDATE SET name = EXCLUDED.name
		RETURNING id`,
		id, input.Name, input.Payload, idempotency, nullableString(input.CorrelationID), notBefore,
	).Scan(&storedID)
	if err != nil {
		return "", err
	}
	return ports.JobID(storedID), nil
}

func (s *JobStore) Get(ctx context.Context, id ports.JobID) (job.Record, bool, error) {
	row := s.db.QueryRowContext(ctx, `
		SELECT id, name, payload, state, attempts, COALESCE(idempotency_key, ''),
		       COALESCE(correlation_id, ''), created_at, not_before,
		       COALESCE(lease_id, ''), COALESCE(lease_until, 'epoch'::timestamptz), cancel_requested
		FROM rhinoq_jobs WHERE id = $1`, string(id))
	record, err := scanJob(row)
	if errors.Is(err, sql.ErrNoRows) {
		return job.Record{}, false, nil
	}
	return record, err == nil, err
}

func (s *JobStore) ListJobs(ctx context.Context, input ports.ListJobsInput) ([]job.Record, error) {
	if input.Offset < 0 || input.Limit <= 0 || input.Limit > 1000 {
		return nil, errors.New("offset must be non-negative and limit must be between 1 and 1000")
	}
	args := []any{input.Name}
	var query strings.Builder
	query.WriteString(`
		SELECT id, name, payload, state, attempts, COALESCE(idempotency_key, ''),
		       COALESCE(correlation_id, ''), created_at, not_before,
		       COALESCE(lease_id, ''), COALESCE(lease_until, 'epoch'::timestamptz), cancel_requested
		FROM rhinoq_jobs
		WHERE ($1 = '' OR name = $1)`)
	if len(input.States) > 0 {
		query.WriteString(" AND state IN (")
		for index, state := range input.States {
			if !state.Valid() {
				return nil, errors.New("invalid job state filter")
			}
			if index > 0 {
				query.WriteString(", ")
			}
			args = append(args, state.String())
			fmt.Fprintf(&query, "$%d", len(args))
		}
		query.WriteString(")")
	}
	args = append(args, input.Limit, input.Offset)
	fmt.Fprintf(&query, " ORDER BY created_at DESC, id DESC LIMIT $%d OFFSET $%d", len(args)-1, len(args))

	rows, err := s.db.QueryContext(ctx, query.String(), args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	records := make([]job.Record, 0, input.Limit)
	for rows.Next() {
		record, err := scanJob(rows)
		if err != nil {
			return nil, err
		}
		records = append(records, record)
	}
	return records, rows.Err()
}

func (s *JobStore) JobCounts(ctx context.Context, name string) (map[job.State]int64, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT state, count(*)
		FROM rhinoq_jobs
		WHERE ($1 = '' OR name = $1)
		GROUP BY state`, name)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	counts := make(map[job.State]int64)
	for rows.Next() {
		var state string
		var count int64
		if err := rows.Scan(&state, &count); err != nil {
			return nil, err
		}
		counts[job.State(state)] = count
	}
	return counts, rows.Err()
}

func (s *JobStore) Claim(ctx context.Context, input ports.ClaimInput) ([]job.Record, error) {
	if input.Limit <= 0 || input.LeaseDuration <= 0 || input.Now.IsZero() {
		return nil, errors.New("invalid claim input")
	}
	tx, err := s.db.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelReadCommitted})
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()

	candidateLimit := input.Limit
	if candidateLimit <= 1000 {
		candidateLimit *= 4
	}
	rows, err := tx.QueryContext(ctx, `
		SELECT j.id, j.name, j.payload, j.state, j.attempts, COALESCE(j.idempotency_key, ''),
		       COALESCE(j.correlation_id, ''), j.created_at, j.not_before,
		       COALESCE(j.lease_id, ''), COALESCE(j.lease_until, 'epoch'::timestamptz), j.cancel_requested
		FROM rhinoq_jobs j
		LEFT JOIN rhinoq_queue_controls qc ON qc.queue_name = j.name
		WHERE j.state IN ('pending', 'retry_wait') AND j.not_before <= $1
		  AND qc.paused_at IS NULL
		  AND (
		      qc.rate_limit_max IS NULL
		      OR qc.rate_window_started_at IS NULL
		      OR qc.rate_window_started_at + (qc.rate_limit_window_ms * interval '1 millisecond') <= $1
		      OR qc.rate_window_count < qc.rate_limit_max
		  )
		ORDER BY j.created_at, j.id
		FOR UPDATE OF j SKIP LOCKED
		LIMIT $2`, input.Now, candidateLimit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	candidates := make([]job.Record, 0, candidateLimit)
	for rows.Next() {
		record, err := scanJob(rows)
		if err != nil {
			return nil, err
		}
		candidates = append(candidates, record)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if err := rows.Close(); err != nil {
		return nil, err
	}

	claimed := make([]job.Record, 0, input.Limit)
	for _, record := range candidates {
		if len(claimed) == input.Limit {
			break
		}
		allowed, err := s.allowClaimTx(ctx, tx, record.Name, input.Now)
		if err != nil {
			return nil, err
		}
		if !allowed {
			continue
		}
		leaseID, err := newID("lease")
		if err != nil {
			return nil, err
		}
		leaseUntil := input.Now.Add(input.LeaseDuration)
		if _, err := tx.ExecContext(ctx, `
			UPDATE rhinoq_jobs
			SET state = 'leased', attempts = attempts + 1, lease_id = $1, lease_until = $2
			WHERE id = $3`, leaseID, leaseUntil, record.ID); err != nil {
			return nil, err
		}
		record.State = job.Leased
		record.Attempts++
		record.LeaseID = leaseID
		record.LeaseUntil = leaseUntil
		claimed = append(claimed, record)
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return claimed, nil
}

func (s *JobStore) PauseQueue(ctx context.Context, name string) error {
	if name == "" {
		return errors.New("queue name is required")
	}
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO rhinoq_queue_controls (queue_name, paused_at)
		VALUES ($1, now())
		ON CONFLICT (queue_name) DO UPDATE SET paused_at = now()`, name)
	return err
}

func (s *JobStore) ResumeQueue(ctx context.Context, name string) error {
	if name == "" {
		return errors.New("queue name is required")
	}
	_, err := s.db.ExecContext(ctx, `UPDATE rhinoq_queue_controls SET paused_at = NULL WHERE queue_name = $1`, name)
	return err
}

func (s *JobStore) SetQueueRateLimit(ctx context.Context, name string, limit ports.QueueRateLimit) error {
	if name == "" || limit.Max <= 0 || limit.Window < time.Millisecond {
		return errors.New("queue name, positive max and a window of at least one millisecond are required")
	}
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO rhinoq_queue_controls
			(queue_name, rate_limit_max, rate_limit_window_ms, rate_window_started_at, rate_window_count)
		VALUES ($1, $2, $3, NULL, 0)
		ON CONFLICT (queue_name) DO UPDATE
		SET rate_limit_max = EXCLUDED.rate_limit_max,
		    rate_limit_window_ms = EXCLUDED.rate_limit_window_ms,
		    rate_window_started_at = NULL,
		    rate_window_count = 0,
		    updated_at = now()`,
		name, limit.Max, limit.Window.Milliseconds())
	return err
}

func (s *JobStore) RemoveQueueRateLimit(ctx context.Context, name string) error {
	if name == "" {
		return errors.New("queue name is required")
	}
	_, err := s.db.ExecContext(ctx, `
		UPDATE rhinoq_queue_controls
		SET rate_limit_max = NULL,
		    rate_limit_window_ms = NULL,
		    rate_window_started_at = NULL,
		    rate_window_count = 0,
		    updated_at = now()
		WHERE queue_name = $1`, name)
	return err
}

func (s *JobStore) QueueRateLimitTTL(ctx context.Context, name string, now time.Time) (time.Duration, error) {
	if name == "" || now.IsZero() {
		return 0, errors.New("queue name and current time are required")
	}
	var max, windowMS sql.NullInt64
	var windowStarted sql.NullTime
	var count int
	err := s.db.QueryRowContext(ctx, `
		SELECT rate_limit_max, rate_limit_window_ms, rate_window_started_at, rate_window_count
		FROM rhinoq_queue_controls WHERE queue_name = $1`, name).
		Scan(&max, &windowMS, &windowStarted, &count)
	if errors.Is(err, sql.ErrNoRows) {
		return 0, nil
	}
	if err != nil {
		return 0, err
	}
	if !max.Valid || !windowMS.Valid || !windowStarted.Valid || int64(count) < max.Int64 {
		return 0, nil
	}
	ttl := windowStarted.Time.Add(time.Duration(windowMS.Int64) * time.Millisecond).Sub(now)
	if ttl < 0 {
		return 0, nil
	}
	return ttl, nil
}

func (s *JobStore) RenewLease(ctx context.Context, lease ports.Lease, now time.Time, extension time.Duration) error {
	if lease.JobID == "" || lease.LeaseID == "" || now.IsZero() || extension <= 0 {
		return ErrLeaseLost
	}
	result, err := s.db.ExecContext(ctx, `
		UPDATE rhinoq_jobs SET lease_until = $1
		WHERE id = $2 AND state = 'leased' AND lease_id = $3 AND lease_until > $4`,
		now.Add(extension), lease.JobID, lease.LeaseID, now)
	if err != nil {
		return err
	}
	if affected, _ := result.RowsAffected(); affected != 1 {
		return ErrLeaseLost
	}
	return nil
}

func (s *JobStore) Complete(ctx context.Context, lease ports.Lease, now time.Time) error {
	if lease.JobID == "" || lease.LeaseID == "" || now.IsZero() {
		return ErrLeaseLost
	}
	result, err := s.db.ExecContext(ctx, `
		UPDATE rhinoq_jobs
		SET state = 'succeeded', lease_id = NULL, lease_until = NULL
		WHERE id = $1 AND state = 'leased' AND lease_id = $2 AND lease_until > $3`,
		lease.JobID, lease.LeaseID, now)
	if err != nil {
		return err
	}
	if affected, _ := result.RowsAffected(); affected != 1 {
		return ErrLeaseLost
	}
	return nil
}

func (s *JobStore) Fail(ctx context.Context, lease ports.Lease, now time.Time, transition ports.FailureTransition) error {
	if lease.JobID == "" || lease.LeaseID == "" || now.IsZero() {
		return ErrLeaseLost
	}
	if transition.State != job.RetryWait && transition.State != job.Dead && transition.State != job.Blocked && transition.State != job.Cancelled {
		return errors.New("invalid failure state")
	}
	result, err := s.db.ExecContext(ctx, `
		UPDATE rhinoq_jobs
		SET state = $1, not_before = $2, lease_id = NULL, lease_until = NULL
		WHERE id = $3 AND state = 'leased' AND lease_id = $4 AND lease_until > $5`,
		transition.State, transition.NotBefore, lease.JobID, lease.LeaseID, now)
	if err != nil {
		return err
	}
	if affected, _ := result.RowsAffected(); affected != 1 {
		return ErrLeaseLost
	}
	return nil
}

func (s *JobStore) RequestCancel(ctx context.Context, id ports.JobID) error {
	result, err := s.db.ExecContext(ctx, `
		UPDATE rhinoq_jobs
		SET state = CASE WHEN state IN ('pending', 'retry_wait', 'blocked') THEN 'cancelled' ELSE state END,
		    cancel_requested = CASE WHEN state = 'leased' THEN true ELSE cancel_requested END,
		    lease_id = CASE WHEN state IN ('pending', 'retry_wait', 'blocked') THEN NULL ELSE lease_id END,
		    lease_until = CASE WHEN state IN ('pending', 'retry_wait', 'blocked') THEN NULL ELSE lease_until END
		WHERE id = $1 AND state NOT IN ('succeeded', 'dead', 'cancelled')`, id)
	if err != nil {
		return err
	}
	if affected, _ := result.RowsAffected(); affected != 1 {
		return ErrNotFound
	}
	return nil
}

func (s *JobStore) IsCancelRequested(ctx context.Context, id ports.JobID) (bool, error) {
	var requested bool
	err := s.db.QueryRowContext(ctx, `SELECT cancel_requested FROM rhinoq_jobs WHERE id = $1`, id).Scan(&requested)
	if errors.Is(err, sql.ErrNoRows) {
		return false, ErrNotFound
	}
	return requested, err
}

func (s *JobStore) RequeueExpired(ctx context.Context, now time.Time) (int, error) {
	if now.IsZero() {
		return 0, errors.New("reaper time is required")
	}
	result, err := s.db.ExecContext(ctx, `
		UPDATE rhinoq_jobs
		SET state = 'retry_wait', not_before = $1, lease_id = NULL, lease_until = NULL
		WHERE state = 'leased' AND lease_until <= $1`, now)
	if err != nil {
		return 0, err
	}
	count, err := result.RowsAffected()
	return int(count), err
}

func (s *JobStore) allowClaimTx(ctx context.Context, tx *sql.Tx, name string, now time.Time) (bool, error) {
	var max, windowMS sql.NullInt64
	var pausedAt, windowStarted sql.NullTime
	var count int
	err := tx.QueryRowContext(ctx, `
		SELECT paused_at, rate_limit_max, rate_limit_window_ms, rate_window_started_at, rate_window_count
		FROM rhinoq_queue_controls
		WHERE queue_name = $1
		FOR UPDATE`, name).Scan(&pausedAt, &max, &windowMS, &windowStarted, &count)
	if errors.Is(err, sql.ErrNoRows) {
		return true, nil
	}
	if err != nil {
		return false, err
	}
	if pausedAt.Valid {
		return false, nil
	}
	if !max.Valid || !windowMS.Valid {
		return true, nil
	}
	window := time.Duration(windowMS.Int64) * time.Millisecond
	if !windowStarted.Valid || !now.Before(windowStarted.Time.Add(window)) {
		_, err = tx.ExecContext(ctx, `
			UPDATE rhinoq_queue_controls
			SET rate_window_started_at = $1, rate_window_count = 1, updated_at = $1
			WHERE queue_name = $2`, now, name)
		return err == nil, err
	}
	if int64(count) >= max.Int64 {
		return false, nil
	}
	_, err = tx.ExecContext(ctx, `
		UPDATE rhinoq_queue_controls
		SET rate_window_count = rate_window_count + 1, updated_at = $1
		WHERE queue_name = $2`, now, name)
	return err == nil, err
}

type scanner interface {
	Scan(dest ...any) error
}

func scanJob(row scanner) (job.Record, error) {
	var record job.Record
	var id, state string
	if err := row.Scan(&id, &record.Name, &record.Payload, &state, &record.Attempts,
		&record.IdempotencyKey, &record.CorrelationID, &record.CreatedAt, &record.NotBefore,
		&record.LeaseID, &record.LeaseUntil, &record.CancelRequested); err != nil {
		return job.Record{}, err
	}
	record.ID = job.ID(id)
	record.State = job.State(state)
	return record, nil
}

func nullableString(value string) any {
	if value == "" {
		return nil
	}
	return value
}

func newID(prefix string) (string, error) {
	bytes := make([]byte, 16)
	if _, err := rand.Read(bytes); err != nil {
		return "", fmt.Errorf("generate %s id: %w", prefix, err)
	}
	return prefix + "_" + hex.EncodeToString(bytes), nil
}
