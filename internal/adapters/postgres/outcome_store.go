package postgres

import (
	"context"
	"database/sql"
	"errors"

	"github.com/rhinoq/rhinoq/internal/domain/outcome"
)

type OutcomeStore struct {
	db *sql.DB
}

func NewOutcomeStore(db *sql.DB) (*OutcomeStore, error) {
	if db == nil {
		return nil, errors.New("postgres database is required")
	}
	return &OutcomeStore{db: db}, nil
}

func (s *OutcomeStore) SaveOutcome(ctx context.Context, record outcome.Record) error {
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO rhinoq_outcomes
			(id, job_id, contract_version, state, reason, observed_version, updated_at)
		VALUES ($1, $2, $3, $4, $5, $6, $7)
		ON CONFLICT (job_id, contract_version)
		DO UPDATE SET state = EXCLUDED.state,
		              reason = EXCLUDED.reason,
		              observed_version = EXCLUDED.observed_version,
		              updated_at = EXCLUDED.updated_at`,
		record.ID, record.JobID, record.ContractVersion, record.State,
		nullableString(record.Reason), record.ObservedVersion, record.UpdatedAt)
	return err
}

func (s *OutcomeStore) GetOutcome(ctx context.Context, id string) (outcome.Record, bool, error) {
	var record outcome.Record
	err := s.db.QueryRowContext(ctx, `
		SELECT id, job_id, contract_version, state, COALESCE(reason, ''),
		       observed_version, updated_at
		FROM rhinoq_outcomes WHERE id = $1`, id).
		Scan(&record.ID, &record.JobID, &record.ContractVersion, &record.State,
			&record.Reason, &record.ObservedVersion, &record.UpdatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return outcome.Record{}, false, nil
	}
	return record, err == nil, err
}
