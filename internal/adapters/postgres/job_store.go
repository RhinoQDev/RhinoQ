package postgres

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
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

func (s *JobStore) Claim(ctx context.Context, input ports.ClaimInput) ([]job.Record, error) {
	if input.Limit <= 0 || input.LeaseDuration <= 0 || input.Now.IsZero() {
		return nil, errors.New("invalid claim input")
	}
	tx, err := s.db.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelReadCommitted})
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()

	rows, err := tx.QueryContext(ctx, `
		SELECT id, name, payload, state, attempts, COALESCE(idempotency_key, ''),
		       COALESCE(correlation_id, ''), created_at, not_before,
		       COALESCE(lease_id, ''), COALESCE(lease_until, 'epoch'::timestamptz), cancel_requested
		FROM rhinoq_jobs
		WHERE state IN ('pending', 'retry_wait') AND not_before <= $1
		  AND NOT EXISTS (SELECT 1 FROM rhinoq_queue_controls qc WHERE qc.queue_name = rhinoq_jobs.name AND qc.paused_at IS NOT NULL)
		ORDER BY created_at, id
		FOR UPDATE SKIP LOCKED
		LIMIT $2`, input.Now, input.Limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	claimed := make([]job.Record, 0, input.Limit)
	for rows.Next() {
		record, err := scanJob(rows)
		if err != nil {
			return nil, err
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
	if err := rows.Err(); err != nil {
		return nil, err
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
