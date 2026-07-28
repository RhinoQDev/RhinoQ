package postgres

import (
	"context"
	"database/sql"
	"errors"

	"github.com/madebyduy/RhinoQ/internal/domain/change"
)

type ChangeStore struct {
	db *sql.DB
}

func NewChangeStore(db *sql.DB) (*ChangeStore, error) {
	if db == nil {
		return nil, errors.New("postgres database is required")
	}
	return &ChangeStore{db: db}, nil
}

func (s *ChangeStore) PublishChange(
	ctx context.Context,
	record change.Record,
) (change.Record, error) {
	if err := record.Validate(); err != nil {
		return change.Record{}, err
	}
	normalized, err := record.Subject.Normalize()
	if err != nil {
		return change.Record{}, err
	}
	record.Subject = normalized
	err = s.db.QueryRowContext(ctx, `
		INSERT INTO rhinoq_subject_changes
			(subject_type, subject_id, business_key, changed_at, created_at)
		VALUES ($1,$2,$3,$4,now())
		RETURNING id, created_at`,
		record.Subject.Type, record.Subject.ID, nullableString(record.BusinessKey),
		record.ChangedAt,
	).Scan(&record.ID, &record.CreatedAt)
	return record, err
}

func (s *ChangeStore) ListPendingChanges(
	ctx context.Context,
	cursor change.Cursor,
	limit int,
) ([]change.Record, error) {
	if !cursor.Valid() || limit <= 0 || limit > 1000 {
		return nil, errors.New("invalid change cursor or limit")
	}
	rows, err := s.db.QueryContext(ctx, `
		SELECT id, subject_type, subject_id, COALESCE(business_key, ''),
		       changed_at, created_at, processed_at, COALESCE(last_error, '')
		FROM rhinoq_subject_changes
		WHERE processed_at IS NULL
		  AND (
		    $1::timestamptz IS NULL
		    OR (changed_at, subject_id, id) > ($1, $2, $3)
		  )
		ORDER BY changed_at, subject_id, id
		LIMIT $4`,
		nullableTime(cursor.ChangedAt), cursor.SubjectID, cursor.Sequence, limit,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	records := make([]change.Record, 0, limit)
	for rows.Next() {
		var record change.Record
		var processed sql.NullTime
		if err := rows.Scan(
			&record.ID, &record.Subject.Type, &record.Subject.ID,
			&record.BusinessKey, &record.ChangedAt, &record.CreatedAt,
			&processed, &record.LastError,
		); err != nil {
			return nil, err
		}
		if processed.Valid {
			record.ProcessedAt = processed.Time
		}
		records = append(records, record)
	}
	return records, rows.Err()
}

func (s *ChangeStore) CompleteChange(ctx context.Context, id int64) error {
	result, err := s.db.ExecContext(ctx, `
		UPDATE rhinoq_subject_changes
		SET processed_at = now(), last_error = NULL
		WHERE id = $1 AND processed_at IS NULL`, id)
	if err != nil {
		return err
	}
	affected, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if affected != 1 {
		return errors.New("change was already processed or does not exist")
	}
	return nil
}

func (s *ChangeStore) FailChange(
	ctx context.Context,
	id int64,
	message string,
) error {
	_, err := s.db.ExecContext(ctx, `
		UPDATE rhinoq_subject_changes
		SET last_error = $2
		WHERE id = $1 AND processed_at IS NULL`,
		id, message,
	)
	return err
}
