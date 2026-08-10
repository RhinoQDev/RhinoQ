package postgres

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/madebyduy/RhinoQ/internal/domain/provideroperation"
	"github.com/madebyduy/RhinoQ/internal/ports"
)

type ProviderOperationStore struct{ db *sql.DB }

func NewProviderOperationStore(db *sql.DB) (*ProviderOperationStore, error) {
	if db == nil {
		return nil, errors.New("postgres database is required")
	}
	return &ProviderOperationStore{db: db}, nil
}

func (s *ProviderOperationStore) ListProviderOperations(ctx context.Context, states []provideroperation.State, before time.Time, limit int) ([]provideroperation.Record, error) {
	if limit < 1 || limit > 500 || before.IsZero() || len(states) == 0 {
		return nil, fmt.Errorf("provider operation query requires states, before and limit 1..500")
	}
	args := make([]any, 0, len(states)+2)
	marks := make([]string, len(states))
	for i, state := range states {
		args = append(args, state)
		marks[i] = fmt.Sprintf("$%d", i+1)
	}
	args = append(args, before, limit)
	rows, err := s.db.QueryContext(ctx, providerOperationSelect+` WHERE op.state IN (`+strings.Join(marks, ",")+`)
		AND op.updated_at <= $`+fmt.Sprint(len(states)+1)+` ORDER BY op.updated_at, op.id LIMIT $`+fmt.Sprint(len(states)+2), args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := make([]provideroperation.Record, 0, limit)
	for rows.Next() {
		record, scanErr := scanProviderOperation(rows)
		if scanErr != nil {
			return nil, scanErr
		}
		items = append(items, record)
	}
	return items, rows.Err()
}

const providerOperationSelect = `SELECT op.id, COALESCE(op.task_id,''), op.provider,
	op.operation, op.idempotency_key, COALESCE(op.request_fingerprint,''), op.confirmation_policy, op.retry_policy,
	op.state, COALESCE(op.provider_id,''),
	COALESCE((SELECT evidence.payload FROM rhinoq_provider_operation_evidence AS evidence
		WHERE evidence.operation_id=op.id ORDER BY evidence.sequence DESC LIMIT 1),''),
	COALESCE(op.reason,''), op.version, op.created_at, op.updated_at
	FROM rhinoq_provider_operations AS op`

func scanProviderOperation(row rowScanner) (provideroperation.Record, error) {
	var record provideroperation.Record
	err := row.Scan(&record.ID, &record.TaskID, &record.Provider, &record.Operation, &record.IdempotencyKey,
		&record.RequestFingerprint, &record.Confirmation, &record.RetryPolicy, &record.State,
		&record.ProviderID, &record.Evidence, &record.Reason,
		&record.Version, &record.CreatedAt, &record.UpdatedAt)
	return record, err
}

func (s *ProviderOperationStore) BeginProviderOperation(ctx context.Context, record provideroperation.Record) (provideroperation.Record, error) {
	var id provideroperation.ID
	err := s.db.QueryRowContext(ctx, `
		INSERT INTO rhinoq_provider_operations
			(id, task_id, provider, operation, idempotency_key, confirmation_policy,
			retry_policy, request_fingerprint, state, provider_id, evidence, reason, version, created_at, updated_at)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NULL,NULL,NULL,$10,$11,$12)
		ON CONFLICT (provider, operation, idempotency_key)
		DO UPDATE SET provider = EXCLUDED.provider
		RETURNING id`, record.ID, nullableString(record.TaskID), record.Provider,
		record.Operation, record.IdempotencyKey, record.Confirmation, record.RetryPolicy,
		record.RequestFingerprint, record.State, record.Version, record.CreatedAt, record.UpdatedAt).Scan(&id)
	if err != nil {
		return provideroperation.Record{}, err
	}
	stored, _, err := s.GetProviderOperation(ctx, id)
	return stored, err
}

func (s *ProviderOperationStore) GetProviderOperation(ctx context.Context, id provideroperation.ID) (provideroperation.Record, bool, error) {
	record, err := scanProviderOperation(s.db.QueryRowContext(ctx, providerOperationSelect+` WHERE op.id=$1`, id))
	if errors.Is(err, sql.ErrNoRows) {
		return provideroperation.Record{}, false, nil
	}
	return record, err == nil, err
}

func (s *ProviderOperationStore) SaveProviderOperation(ctx context.Context, record provideroperation.Record, expected int64, evidence *provideroperation.Evidence) (provideroperation.Record, error) {
	if expected <= 0 || record.Version != expected+1 {
		return provideroperation.Record{}, ports.ErrVersionConflict
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return provideroperation.Record{}, err
	}
	defer func() { _ = tx.Rollback() }()
	result, err := tx.ExecContext(ctx, `UPDATE rhinoq_provider_operations
		SET state=$2, provider_id=$3, evidence=NULL, reason=$4, version=$5, updated_at=$6
		WHERE id=$1 AND version=$7`, record.ID, record.State,
		nullableString(record.ProviderID), nullableString(record.Reason), record.Version,
		record.UpdatedAt, expected)
	if err != nil {
		return provideroperation.Record{}, err
	}
	rows, err := result.RowsAffected()
	if err != nil {
		return provideroperation.Record{}, err
	}
	if rows == 0 {
		if _, found, getErr := s.GetProviderOperation(ctx, record.ID); getErr != nil {
			return provideroperation.Record{}, getErr
		} else if !found {
			return provideroperation.Record{}, ports.ErrProviderOperationNotFound
		}
		return provideroperation.Record{}, ports.ErrVersionConflict
	}
	if evidence != nil {
		_, err = tx.ExecContext(ctx, `INSERT INTO rhinoq_provider_operation_evidence
			(operation_id, kind, payload, created_at) VALUES ($1,$2,$3,$4)`,
			record.ID, evidence.Kind, evidence.Payload, evidence.CreatedAt)
		if err != nil {
			return provideroperation.Record{}, err
		}
	}
	if err = tx.Commit(); err != nil {
		return provideroperation.Record{}, err
	}
	updated, _, err := s.GetProviderOperation(ctx, record.ID)
	return updated, err
}

func (s *ProviderOperationStore) ListProviderOperationEvidence(ctx context.Context, id provideroperation.ID) ([]provideroperation.Evidence, error) {
	if _, found, err := s.GetProviderOperation(ctx, id); err != nil {
		return nil, err
	} else if !found {
		return nil, ports.ErrProviderOperationNotFound
	}
	rows, err := s.db.QueryContext(ctx, `SELECT sequence, operation_id, kind, payload, created_at
		FROM rhinoq_provider_operation_evidence WHERE operation_id=$1 ORDER BY sequence`, id)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := make([]provideroperation.Evidence, 0)
	for rows.Next() {
		var item provideroperation.Evidence
		if err := rows.Scan(&item.Sequence, &item.OperationID, &item.Kind, &item.Payload, &item.CreatedAt); err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	return items, rows.Err()
}
