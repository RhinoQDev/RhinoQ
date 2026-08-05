package postgres

import (
	"context"
	"database/sql"
	"errors"
	"strconv"
	"strings"

	"github.com/madebyduy/RhinoQ/internal/domain/subjectoutcome"
)

// subjectOutcomeColumns is shared by the single-row and batch reads so the two
// paths cannot drift into scanning different shapes.
const subjectOutcomeColumns = `rule_id, rule_version, subject_type, subject_id, status,
	       COALESCE(reason, ''), COALESCE(evidence, ''),
	       first_unknown_at, last_observed_at, unknown_count, updated_at`

type SubjectOutcomeStore struct {
	db *sql.DB
}

func NewSubjectOutcomeStore(db *sql.DB) (*SubjectOutcomeStore, error) {
	if db == nil {
		return nil, errors.New("postgres database is required")
	}
	return &SubjectOutcomeStore{db: db}, nil
}

func scanSubjectOutcome(scan func(...any) error) (subjectoutcome.Record, error) {
	var record subjectoutcome.Record
	var firstUnknown sql.NullTime
	err := scan(
		&record.RuleID, &record.RuleVersion, &record.SubjectType,
		&record.SubjectID, &record.Status, &record.Reason, &record.Evidence,
		&firstUnknown, &record.LastObservedAt,
		&record.UnknownCount, &record.UpdatedAt,
	)
	if firstUnknown.Valid {
		record.FirstUnknownAt = firstUnknown.Time
	}
	return record, err
}

func (s *SubjectOutcomeStore) GetSubjectOutcome(
	ctx context.Context,
	key subjectoutcome.Key,
) (subjectoutcome.Record, bool, error) {
	record, err := scanSubjectOutcome(s.db.QueryRowContext(ctx, `
		SELECT `+subjectOutcomeColumns+`
		FROM rhinoq_subject_outcomes
		WHERE rule_id = $1 AND rule_version = $2
		  AND subject_type = $3 AND subject_id = $4`,
		key.RuleID, key.RuleVersion, key.SubjectType, key.SubjectID,
	).Scan)
	if errors.Is(err, sql.ErrNoRows) {
		return subjectoutcome.Record{}, false, nil
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

// batchIdentity returns the Rule identity every member of a page shares, and
// refuses the batch if they do not share one. The statements below bind
// rule_id, rule_version and subject_type once and vary only the subject, which
// is sound precisely because a Rule page is one Rule version over one subject
// type.
func batchIdentity(keys []subjectoutcome.Key) (subjectoutcome.Key, error) {
	identity := keys[0]
	identity.SubjectID = ""
	for _, key := range keys {
		if err := key.Validate(); err != nil {
			return subjectoutcome.Key{}, err
		}
		if key.RuleID != identity.RuleID ||
			key.RuleVersion != identity.RuleVersion ||
			key.SubjectType != identity.SubjectType {
			return subjectoutcome.Key{}, errors.New(
				"a subject outcome batch must belong to one Rule version and subject type",
			)
		}
	}
	return identity, nil
}

// placeholders renders "$first, $first+1, ... " for count parameters. The store
// accepts any database/sql driver, so it cannot bind a Go slice as an array the
// way a driver-specific encoder would; numbered placeholders work everywhere and
// keep every value parameterised.
func placeholders(first, count int) string {
	var buf strings.Builder
	for index := range count {
		if index > 0 {
			buf.WriteString(", ")
		}
		buf.WriteByte('$')
		buf.WriteString(strconv.Itoa(first + index))
	}
	return buf.String()
}

func (s *SubjectOutcomeStore) GetSubjectOutcomes(
	ctx context.Context,
	keys []subjectoutcome.Key,
) (map[string]subjectoutcome.Record, error) {
	outcomes := make(map[string]subjectoutcome.Record, len(keys))
	if len(keys) == 0 {
		return outcomes, nil
	}
	identity, err := batchIdentity(keys)
	if err != nil {
		return nil, err
	}
	arguments := make([]any, 0, len(keys)+3)
	arguments = append(arguments, identity.RuleID, identity.RuleVersion, identity.SubjectType)
	for _, key := range keys {
		arguments = append(arguments, key.SubjectID)
	}
	rows, err := s.db.QueryContext(ctx, `
		SELECT `+subjectOutcomeColumns+`
		FROM rhinoq_subject_outcomes
		WHERE rule_id = $1 AND rule_version = $2 AND subject_type = $3
		  AND subject_id IN (`+placeholders(4, len(keys))+`)`,
		arguments...,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		record, err := scanSubjectOutcome(rows.Scan)
		if err != nil {
			return nil, err
		}
		outcomes[record.SubjectID] = record
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return outcomes, rows.Close()
}

func (s *SubjectOutcomeStore) SaveSubjectOutcomes(
	ctx context.Context,
	records []subjectoutcome.Record,
) (map[string]bool, error) {
	applied := make(map[string]bool, len(records))
	if len(records) == 0 {
		return applied, nil
	}
	keys := make([]subjectoutcome.Key, 0, len(records))
	for _, record := range records {
		keys = append(keys, record.Key)
	}
	identity, err := batchIdentity(keys)
	if err != nil {
		return nil, err
	}

	const columnsPerRow = 8
	arguments := make([]any, 0, 3+len(records)*columnsPerRow)
	arguments = append(arguments, identity.RuleID, identity.RuleVersion, identity.SubjectType)
	var values strings.Builder
	for index, record := range records {
		if index > 0 {
			values.WriteString(",\n\t\t\t")
		}
		first := 4 + index*columnsPerRow
		// Only the first row carries casts. PostgreSQL infers the rest of the
		// VALUES list from it, and an untyped first row would make the whole
		// list default to text.
		if index == 0 {
			values.WriteString(
				"($" + strconv.Itoa(first) + "::text, $" + strconv.Itoa(first+1) +
					"::text, $" + strconv.Itoa(first+2) + "::text, $" + strconv.Itoa(first+3) +
					"::text, $" + strconv.Itoa(first+4) + "::timestamptz, $" + strconv.Itoa(first+5) +
					"::timestamptz, $" + strconv.Itoa(first+6) + "::integer, $" + strconv.Itoa(first+7) +
					"::timestamptz)")
		} else {
			values.WriteString("(" + placeholders(first, columnsPerRow) + ")")
		}
		arguments = append(arguments,
			record.SubjectID,
			string(record.Status),
			nullableString(record.Reason),
			nullableString(record.Evidence),
			nullableTime(record.FirstUnknownAt),
			record.LastObservedAt,
			record.UnknownCount,
			record.UpdatedAt,
		)
	}

	// RETURNING names the rows the staleness guard actually let through. It is
	// the batch equivalent of SaveSubjectOutcome's boolean: an observation that
	// lost to a newer one drops out instead of overwriting it, and the caller
	// must not project it into a Finding.
	rows, err := s.db.QueryContext(ctx, `
		INSERT INTO rhinoq_subject_outcomes AS existing
			(rule_id, rule_version, subject_type, subject_id, status,
			 reason, evidence, first_unknown_at, last_observed_at,
			 unknown_count, updated_at)
		SELECT $1, $2, $3, page.subject_id, page.status, page.reason,
		       page.evidence, page.first_unknown_at, page.last_observed_at,
		       page.unknown_count, page.updated_at
		FROM (VALUES
			`+values.String()+`
		) AS page(subject_id, status, reason, evidence,
		          first_unknown_at, last_observed_at, unknown_count, updated_at)
		ON CONFLICT (rule_id, rule_version, subject_type, subject_id)
		DO UPDATE SET status = EXCLUDED.status,
		              reason = EXCLUDED.reason,
		              evidence = EXCLUDED.evidence,
		              first_unknown_at = EXCLUDED.first_unknown_at,
		              last_observed_at = EXCLUDED.last_observed_at,
		              unknown_count = EXCLUDED.unknown_count,
		              updated_at = EXCLUDED.updated_at
		WHERE existing.last_observed_at <= EXCLUDED.last_observed_at
		RETURNING subject_id`,
		arguments...,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var subjectID string
		if err := rows.Scan(&subjectID); err != nil {
			return nil, err
		}
		applied[subjectID] = true
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return applied, rows.Close()
}
