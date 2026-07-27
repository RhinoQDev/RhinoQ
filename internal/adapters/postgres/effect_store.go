package postgres

import (
	"context"
	"database/sql"
	"errors"

	"github.com/rhinoq/rhinoq/internal/domain/effect"
)

type EffectStore struct {
	db *sql.DB
}

func NewEffectStore(db *sql.DB) (*EffectStore, error) {
	if db == nil {
		return nil, errors.New("postgres database is required")
	}
	return &EffectStore{db: db}, nil
}

func (s *EffectStore) BeginEffect(ctx context.Context, record effect.Record) (effect.Record, error) {
	var stored effect.Record
	err := s.db.QueryRowContext(ctx, `
		INSERT INTO rhinoq_effects
			(id, job_id, name, idempotency_key, state, irreversible, external_ref, created_at)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
		ON CONFLICT (job_id, name, idempotency_key)
		DO UPDATE SET name = EXCLUDED.name
		RETURNING id, job_id, name, idempotency_key, state, irreversible,
		          COALESCE(external_ref, ''), created_at`,
		record.ID, record.JobID, record.Name, record.IdempotencyKey, record.State,
		record.Irreversible, nullableString(record.ExternalRef), record.CreatedAt,
	).Scan(&stored.ID, &stored.JobID, &stored.Name, &stored.IdempotencyKey, &stored.State,
		&stored.Irreversible, &stored.ExternalRef, &stored.CreatedAt)
	return stored, err
}

func (s *EffectStore) GetEffect(ctx context.Context, jobID, name, idempotencyKey string) (effect.Record, bool, error) {
	var record effect.Record
	err := s.db.QueryRowContext(ctx, `
		SELECT id, job_id, name, idempotency_key, state, irreversible,
		       COALESCE(external_ref, ''), created_at
		FROM rhinoq_effects
		WHERE job_id = $1 AND name = $2 AND idempotency_key = $3`, jobID, name, idempotencyKey).
		Scan(&record.ID, &record.JobID, &record.Name, &record.IdempotencyKey, &record.State,
			&record.Irreversible, &record.ExternalRef, &record.CreatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return effect.Record{}, false, nil
	}
	return record, err == nil, err
}

func (s *EffectStore) SaveEffect(ctx context.Context, record effect.Record) error {
	result, err := s.db.ExecContext(ctx, `
		UPDATE rhinoq_effects
		SET state = $1, external_ref = $2
		WHERE id = $3`, record.State, nullableString(record.ExternalRef), record.ID)
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
