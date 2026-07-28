package postgres

import (
	"context"
	"database/sql"
	"errors"

	"github.com/madebyduy/RhinoQ/internal/domain/subjectoutcome"
)

type SubjectOutcomeStore struct {
	db *sql.DB
}

func NewSubjectOutcomeStore(db *sql.DB) (*SubjectOutcomeStore, error) {
	if db == nil {
		return nil, errors.New("postgres database is required")
	}
	return &SubjectOutcomeStore{db: db}, nil
}

func (s *SubjectOutcomeStore) GetSubjectOutcome(
	ctx context.Context,
	key subjectoutcome.Key,
) (subjectoutcome.Record, bool, error) {
	var record subjectoutcome.Record
	var firstUnknown sql.NullTime
	err := s.db.QueryRowContext(ctx, `
		SELECT rule_id, rule_version, subject_type, subject_id, status,
		       COALESCE(reason, ''), COALESCE(evidence, ''),
		       first_unknown_at, last_observed_at, unknown_count, updated_at
		FROM rhinoq_subject_outcomes
		WHERE rule_id = $1 AND rule_version = $2
		  AND subject_type = $3 AND subject_id = $4`,
		key.RuleID, key.RuleVersion, key.SubjectType, key.SubjectID,
	).Scan(
		&record.RuleID, &record.RuleVersion, &record.SubjectType,
		&record.SubjectID, &record.Status, &record.Reason, &record.Evidence,
		&firstUnknown, &record.LastObservedAt,
		&record.UnknownCount, &record.UpdatedAt,
	)
	if errors.Is(err, sql.ErrNoRows) {
		return subjectoutcome.Record{}, false, nil
	}
	if firstUnknown.Valid {
		record.FirstUnknownAt = firstUnknown.Time
	}
	return record, err == nil, err
}

func (s *SubjectOutcomeStore) SaveSubjectOutcome(
	ctx context.Context,
	record subjectoutcome.Record,
) (bool, error) {
	result, err := s.db.ExecContext(ctx, `
		INSERT INTO rhinoq_subject_outcomes
			(rule_id, rule_version, subject_type, subject_id, status,
			 reason, evidence, first_unknown_at, last_observed_at,
			 unknown_count, updated_at)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
		ON CONFLICT (rule_id, rule_version, subject_type, subject_id)
		DO UPDATE SET status = EXCLUDED.status,
		              reason = EXCLUDED.reason,
		              evidence = EXCLUDED.evidence,
		              first_unknown_at = EXCLUDED.first_unknown_at,
		              last_observed_at = EXCLUDED.last_observed_at,
		              unknown_count = EXCLUDED.unknown_count,
		              updated_at = EXCLUDED.updated_at
		WHERE rhinoq_subject_outcomes.last_observed_at <= EXCLUDED.last_observed_at`,
		record.RuleID, record.RuleVersion, record.SubjectType, record.SubjectID,
		record.Status, nullableString(record.Reason),
		nullableString(record.Evidence), nullableTime(record.FirstUnknownAt),
		record.LastObservedAt, record.UnknownCount, record.UpdatedAt,
	)
	if err != nil {
		return false, err
	}
	affected, err := result.RowsAffected()
	return affected == 1, err
}
