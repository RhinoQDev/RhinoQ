package postgres

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/rhinoq/rhinoq/internal/domain/effect"
	"github.com/rhinoq/rhinoq/internal/ports"
)

var _ ports.EffectStore = (*EffectStore)(nil)
var _ ports.EffectReader = (*EffectStore)(nil)

type EffectStore struct {
	db *sql.DB
}

func NewEffectStore(db *sql.DB) (*EffectStore, error) {
	if db == nil {
		return nil, errors.New("postgres database is required")
	}
	return &EffectStore{db: db}, nil
}

func (s *EffectStore) CheckLease(ctx context.Context, lease ports.Lease, _ time.Time) error {
	if !lease.Valid() {
		return ports.LeaseLost(lease, "the presented lease is incomplete")
	}
	var alive bool
	err := s.db.QueryRowContext(ctx, `
		SELECT true FROM rhinoq_jobs
		WHERE id = $1 AND state = 'leased' AND lease_owner = $2
		  AND lease_epoch = $3 AND lease_until > now()`,
		string(lease.JobID), lease.Owner, lease.Epoch).Scan(&alive)
	if errors.Is(err, sql.ErrNoRows) {
		return ports.LeaseLost(lease, "the stored owner, epoch or expiry no longer matches")
	}
	return err
}

// BeginEffect opens the ledger entry only if the caller still owns the job. The
// fence lives inside the INSERT, so there is no window between checking the
// lease and recording that money is about to move (specification 41.3).
func (s *EffectStore) BeginEffect(ctx context.Context, lease ports.Lease, _ time.Time, record effect.Record) (effect.Record, error) {
	if !lease.Valid() || string(lease.JobID) != record.JobID {
		return effect.Record{}, ports.LeaseLost(lease, "the presented lease does not own this effect")
	}
	var stored effect.Record
	err := s.db.QueryRowContext(ctx, `
		INSERT INTO rhinoq_effects
			(id, job_id, name, idempotency_key, state, irreversible, external_ref, created_at, lease_epoch)
		SELECT $1, $2, $3, $4, $5, $6, $7, $8, $9
		WHERE EXISTS (
			SELECT 1 FROM rhinoq_jobs
			WHERE id = $2 AND state = 'leased' AND lease_owner = $10
			  AND lease_epoch = $9 AND lease_until > now()
		)
		ON CONFLICT (job_id, name, idempotency_key)
		DO UPDATE SET name = EXCLUDED.name
		RETURNING id, job_id, name, idempotency_key, state, irreversible,
		          COALESCE(external_ref, ''), created_at, lease_epoch`,
		string(record.ID), record.JobID, record.Name, record.IdempotencyKey, string(record.State),
		record.Irreversible, nullableString(record.ExternalRef), record.CreatedAt,
		lease.Epoch, lease.Owner,
	).Scan(&stored.ID, &stored.JobID, &stored.Name, &stored.IdempotencyKey, &stored.State,
		&stored.Irreversible, &stored.ExternalRef, &stored.CreatedAt, &stored.LeaseEpoch)
	if errors.Is(err, sql.ErrNoRows) {
		return effect.Record{}, ports.LeaseLost(lease, "the lease expired before the effect could be opened")
	}
	return stored, err
}

func (s *EffectStore) GetEffect(ctx context.Context, jobID, name, idempotencyKey string) (effect.Record, bool, error) {
	var record effect.Record
	err := s.db.QueryRowContext(ctx, `
		SELECT id, job_id, name, idempotency_key, state, irreversible,
		       COALESCE(external_ref, ''), created_at, lease_epoch
		FROM rhinoq_effects
		WHERE job_id = $1 AND name = $2 AND idempotency_key = $3`, jobID, name, idempotencyKey).
		Scan(&record.ID, &record.JobID, &record.Name, &record.IdempotencyKey, &record.State,
			&record.Irreversible, &record.ExternalRef, &record.CreatedAt, &record.LeaseEpoch)
	if errors.Is(err, sql.ErrNoRows) {
		return effect.Record{}, false, nil
	}
	return record, err == nil, err
}

func (s *EffectStore) ListEffects(
	ctx context.Context,
	jobID string,
	offset, limit int,
) ([]effect.Record, error) {
	if jobID == "" || offset < 0 || limit <= 0 || limit > 1000 {
		return nil, errors.New("job id, non-negative offset and limit between 1 and 1000 are required")
	}
	rows, err := s.db.QueryContext(ctx, `
		SELECT id, job_id, name, idempotency_key, state, irreversible,
		       COALESCE(external_ref, ''), created_at, lease_epoch
		FROM rhinoq_effects
		WHERE job_id = $1
		ORDER BY created_at, id
		LIMIT $2 OFFSET $3`, jobID, limit, offset)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	records := make([]effect.Record, 0, limit)
	for rows.Next() {
		var record effect.Record
		if err := rows.Scan(
			&record.ID, &record.JobID, &record.Name, &record.IdempotencyKey,
			&record.State, &record.Irreversible, &record.ExternalRef,
			&record.CreatedAt, &record.LeaseEpoch,
		); err != nil {
			return nil, err
		}
		records = append(records, record)
	}
	return records, rows.Err()
}

// ConfirmEffect records a worker-authored transition and is fenced for the same
// reason as BeginEffect: an execution that lost the job must not be able to
// declare its effect confirmed.
func (s *EffectStore) ConfirmEffect(ctx context.Context, lease ports.Lease, _ time.Time, record effect.Record) error {
	if !lease.Valid() || string(lease.JobID) != record.JobID {
		return ports.LeaseLost(lease, "the presented lease does not own this effect")
	}
	result, err := s.db.ExecContext(ctx, `
		UPDATE rhinoq_effects e
		SET state = $1, external_ref = $2
		WHERE e.id = $3
		  AND EXISTS (
		      SELECT 1 FROM rhinoq_jobs
		      WHERE id = e.job_id AND state = 'leased' AND lease_owner = $4
		        AND lease_epoch = $5 AND lease_until > now()
		  )`, string(record.State), nullableString(record.ExternalRef), string(record.ID),
		lease.Owner, lease.Epoch)
	if err != nil {
		return err
	}
	if affected, _ := result.RowsAffected(); affected != 1 {
		return ports.LeaseLost(lease, "the lease expired before the effect could be confirmed")
	}
	return nil
}

// MarkPendingUncertain downgrades effects left open by executions that died.
// The epoch bound is what keeps the sweep from touching an effect the next
// execution has already opened.
func (s *EffectStore) MarkPendingUncertain(ctx context.Context, expired []ports.ExpiredLease) (int, error) {
	if len(expired) == 0 {
		return 0, nil
	}
	args := make([]any, 0, len(expired)*2)
	conditions := make([]string, 0, len(expired))
	for _, item := range expired {
		args = append(args, string(item.JobID), item.Epoch)
		conditions = append(conditions, fmt.Sprintf("(job_id = $%d AND lease_epoch <= $%d)", len(args)-1, len(args)))
	}
	result, err := s.db.ExecContext(ctx, `
		UPDATE rhinoq_effects
		SET state = 'uncertain'
		WHERE state = 'pending' AND (`+strings.Join(conditions, " OR ")+`)`, args...)
	if err != nil {
		return 0, err
	}
	affected, err := result.RowsAffected()
	return int(affected), err
}

// SaveEffect persists a transition authored by RhinoQ itself, such as the
// reaper moving a pending effect to uncertain once its execution died.
func (s *EffectStore) SaveEffect(ctx context.Context, record effect.Record) error {
	result, err := s.db.ExecContext(ctx, `
		UPDATE rhinoq_effects
		SET state = $1, external_ref = $2
		WHERE id = $3`, string(record.State), nullableString(record.ExternalRef), string(record.ID))
	if err != nil {
		return err
	}
	affected, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if affected != 1 {
		return ErrNotFound
	}
	return nil
}
