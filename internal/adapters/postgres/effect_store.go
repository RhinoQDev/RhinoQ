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

type EffectStore struct {
	db *sql.DB
}

func NewEffectStore(db *sql.DB) (*EffectStore, error) {
	if db == nil {
		return nil, errors.New("postgres database is required")
	}
	return &EffectStore{db: db}, nil
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
