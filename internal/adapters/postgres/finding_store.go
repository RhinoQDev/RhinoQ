package postgres

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/madebyduy/RhinoQ/internal/domain/finding"
	"github.com/madebyduy/RhinoQ/internal/ports"
)

var _ ports.FindingStore = (*FindingStore)(nil)

type FindingStore struct {
	db *sql.DB
}

func NewFindingStore(db *sql.DB) (*FindingStore, error) {
	if db == nil {
		return nil, errors.New("postgres database is required")
	}
	return &FindingStore{db: db}, nil
}

const findingColumns = `rule_id, subject_type, subject_id, invariant_version,
	status, first_seen, last_seen, occurrence_count, latest_evidence,
	actor, reason, suppressed_until, resolved_at, updated_at`

type findingScanner interface {
	Scan(dest ...any) error
}

func scanFinding(row findingScanner) (finding.Record, error) {
	var record finding.Record
	var suppressedUntil, resolvedAt sql.NullTime
	err := row.Scan(
		&record.RuleID, &record.SubjectType, &record.SubjectID,
		&record.ObservedInvariantVersion, &record.Status,
		&record.FirstSeen, &record.LastSeen, &record.OccurrenceCount,
		&record.LatestEvidence, &record.Actor, &record.Reason,
		&suppressedUntil, &resolvedAt, &record.UpdatedAt,
	)
	if suppressedUntil.Valid {
		record.SuppressedUntil = suppressedUntil.Time
	}
	if resolvedAt.Valid {
		record.ResolvedAt = resolvedAt.Time
	}
	return record, err
}

// GetFindingsForSubjects reads the Findings an evaluated page already has.
//
// A Rule page is one Rule id, one subject type and one immutable version, so
// only the subject varies and the result is keyed by subject id.
func (s *FindingStore) GetFindingsForSubjects(
	ctx context.Context,
	keys []finding.Key,
) (map[string]finding.Record, error) {
	records := make(map[string]finding.Record, len(keys))
	if len(keys) == 0 {
		return records, nil
	}
	identity := keys[0]
	arguments := make([]any, 0, len(keys)+3)
	arguments = append(arguments,
		identity.RuleID, identity.SubjectType, identity.ObservedInvariantVersion)
	for _, key := range keys {
		if err := key.Validate(); err != nil {
			return nil, err
		}
		if key.RuleID != identity.RuleID ||
			key.SubjectType != identity.SubjectType ||
			key.ObservedInvariantVersion != identity.ObservedInvariantVersion {
			return nil, errors.New(
				"a finding batch must belong to one Rule, subject type and invariant version",
			)
		}
		arguments = append(arguments, key.SubjectID)
	}
	rows, err := s.db.QueryContext(ctx, `
		SELECT `+findingColumns+`
		FROM rhinoq_findings
		WHERE rule_id = $1 AND subject_type = $2 AND invariant_version = $3
		  AND subject_id IN (`+placeholders(4, len(keys))+`)`,
		arguments...,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		record, err := scanFinding(rows)
		if err != nil {
			return nil, err
		}
		records[record.SubjectID] = record
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return records, rows.Close()
}

func (s *FindingStore) ObserveFinding(
	ctx context.Context,
	observation finding.Observation,
) (finding.Record, error) {
	if err := observation.Validate(); err != nil {
		return finding.Record{}, err
	}
	tx, err := s.db.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelReadCommitted})
	if err != nil {
		return finding.Record{}, err
	}
	defer tx.Rollback()

	if err := lockFindingKey(ctx, tx, observation.Key); err != nil {
		return finding.Record{}, err
	}
	existing, found, err := getFindingForUpdate(ctx, tx, observation.Key)
	if err != nil {
		return finding.Record{}, err
	}
	updated, err := finding.Apply(existing, found, observation)
	if err != nil {
		return finding.Record{}, err
	}
	if found {
		if err := updateFinding(ctx, tx, updated); err != nil {
			return finding.Record{}, err
		}
	} else if err := insertFinding(ctx, tx, updated); err != nil {
		return finding.Record{}, err
	}
	if err := insertFindingEvent(ctx, tx, finding.Event{
		Key: observation.Key, Kind: finding.EventObserved,
		FromStatus: existing.Status, ToStatus: updated.Status,
		Evidence: observation.Evidence, OccurredAt: observation.ObservedAt,
	}); err != nil {
		return finding.Record{}, err
	}
	if err := tx.Commit(); err != nil {
		return finding.Record{}, err
	}
	return updated, nil
}

func (s *FindingStore) ObserveFindingPass(
	ctx context.Context,
	key finding.Key,
	observedAt time.Time,
) (finding.Record, bool, error) {
	if err := key.Validate(); err != nil {
		return finding.Record{}, false, err
	}
	tx, err := s.db.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelReadCommitted})
	if err != nil {
		return finding.Record{}, false, err
	}
	defer tx.Rollback()
	if err := lockFindingKey(ctx, tx, key); err != nil {
		return finding.Record{}, false, err
	}
	existing, found, err := getFindingForUpdate(ctx, tx, key)
	if err != nil {
		return finding.Record{}, false, err
	}
	updated, changed, err := finding.ApplyPass(existing, found, key, observedAt)
	if err != nil || !changed {
		return updated, changed, err
	}
	if err := updateFinding(ctx, tx, updated); err != nil {
		return finding.Record{}, false, err
	}
	if err := insertFindingEvent(ctx, tx, finding.Event{
		Key: key, Kind: finding.EventPassed,
		FromStatus: existing.Status, ToStatus: updated.Status,
		Actor: updated.Actor, Reason: updated.Reason, OccurredAt: observedAt,
	}); err != nil {
		return finding.Record{}, false, err
	}
	if err := tx.Commit(); err != nil {
		return finding.Record{}, false, err
	}
	return updated, true, nil
}

func (s *FindingStore) TransitionFinding(
	ctx context.Context,
	key finding.Key,
	transition finding.Transition,
) (finding.Record, error) {
	if err := key.Validate(); err != nil {
		return finding.Record{}, err
	}
	tx, err := s.db.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelReadCommitted})
	if err != nil {
		return finding.Record{}, err
	}
	defer tx.Rollback()

	if err := lockFindingKey(ctx, tx, key); err != nil {
		return finding.Record{}, err
	}
	existing, found, err := getFindingForUpdate(ctx, tx, key)
	if err != nil {
		return finding.Record{}, err
	}
	if !found {
		return finding.Record{}, ports.ErrFindingNotFound
	}
	updated, err := finding.ApplyTransition(existing, transition)
	if err != nil {
		return finding.Record{}, err
	}
	if err := updateFinding(ctx, tx, updated); err != nil {
		return finding.Record{}, err
	}
	if err := insertFindingEvent(ctx, tx, finding.Event{
		Key: key, Kind: finding.EventTransition,
		FromStatus: existing.Status, ToStatus: updated.Status,
		Actor: transition.Actor, Reason: transition.Reason,
		Until: transition.Until, OccurredAt: transition.At,
	}); err != nil {
		return finding.Record{}, err
	}
	if err := tx.Commit(); err != nil {
		return finding.Record{}, err
	}
	return updated, nil
}

// lockFindingKey serializes the first observation too. SELECT FOR UPDATE
// cannot lock a row that does not exist yet, so without this lock two scanners
// could both attempt the initial insert and one would leak a uniqueness error
// instead of incrementing occurrence_count.
func lockFindingKey(ctx context.Context, tx *sql.Tx, key finding.Key) error {
	_, err := tx.ExecContext(
		ctx,
		`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
		key.String(),
	)
	return err
}

func getFindingForUpdate(
	ctx context.Context,
	tx *sql.Tx,
	key finding.Key,
) (finding.Record, bool, error) {
	record, err := scanFinding(tx.QueryRowContext(ctx, `
		SELECT `+findingColumns+`
		FROM rhinoq_findings
		WHERE rule_id = $1 AND subject_type = $2
		  AND subject_id = $3 AND invariant_version = $4
		FOR UPDATE`,
		key.RuleID, key.SubjectType, key.SubjectID, key.ObservedInvariantVersion,
	))
	if errors.Is(err, sql.ErrNoRows) {
		return finding.Record{}, false, nil
	}
	return record, err == nil, err
}

func insertFinding(ctx context.Context, tx *sql.Tx, record finding.Record) error {
	_, err := tx.ExecContext(ctx, `
		INSERT INTO rhinoq_findings (
			`+findingColumns+`
		) VALUES (
			$1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14
		)`,
		record.RuleID, record.SubjectType, record.SubjectID,
		record.ObservedInvariantVersion, record.Status,
		record.FirstSeen, record.LastSeen, record.OccurrenceCount,
		record.LatestEvidence, record.Actor, record.Reason,
		nullableTime(record.SuppressedUntil), nullableTime(record.ResolvedAt), record.UpdatedAt,
	)
	return err
}

func updateFinding(ctx context.Context, tx *sql.Tx, record finding.Record) error {
	result, err := tx.ExecContext(ctx, `
		UPDATE rhinoq_findings
		SET status = $5, first_seen = $6, last_seen = $7,
		    occurrence_count = $8, latest_evidence = $9, actor = $10,
		    reason = $11, suppressed_until = $12, resolved_at = $13,
		    updated_at = $14
		WHERE rule_id = $1 AND subject_type = $2
		  AND subject_id = $3 AND invariant_version = $4`,
		record.RuleID, record.SubjectType, record.SubjectID,
		record.ObservedInvariantVersion, record.Status,
		record.FirstSeen, record.LastSeen, record.OccurrenceCount,
		record.LatestEvidence, record.Actor, record.Reason,
		nullableTime(record.SuppressedUntil), nullableTime(record.ResolvedAt), record.UpdatedAt,
	)
	if err != nil {
		return err
	}
	affected, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if affected != 1 {
		return ports.ErrFindingNotFound
	}
	return nil
}

func insertFindingEvent(ctx context.Context, tx *sql.Tx, event finding.Event) error {
	_, err := tx.ExecContext(ctx, `
		INSERT INTO rhinoq_finding_events (
			rule_id, subject_type, subject_id, invariant_version, kind,
			from_status, to_status, actor, reason, evidence, suppressed_until,
			occurred_at
		) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
		event.RuleID, event.SubjectType, event.SubjectID,
		event.ObservedInvariantVersion, event.Kind,
		event.FromStatus, event.ToStatus, event.Actor, event.Reason,
		event.Evidence, nullableTime(event.Until), event.OccurredAt,
	)
	return err
}

func (s *FindingStore) GetFinding(
	ctx context.Context,
	key finding.Key,
) (finding.Record, bool, error) {
	if err := key.Validate(); err != nil {
		return finding.Record{}, false, err
	}
	record, err := scanFinding(s.db.QueryRowContext(ctx, `
		SELECT `+findingColumns+`
		FROM rhinoq_findings
		WHERE rule_id = $1 AND subject_type = $2
		  AND subject_id = $3 AND invariant_version = $4`,
		key.RuleID, key.SubjectType, key.SubjectID, key.ObservedInvariantVersion,
	))
	if errors.Is(err, sql.ErrNoRows) {
		return finding.Record{}, false, nil
	}
	return record, err == nil, err
}

func (s *FindingStore) ListFindings(
	ctx context.Context,
	query finding.Query,
) ([]finding.Record, error) {
	if err := query.Validate(); err != nil {
		return nil, err
	}
	where := []string{"1 = 1"}
	args := make([]any, 0, 12)
	add := func(clause string, value any) {
		args = append(args, value)
		where = append(where, fmt.Sprintf(clause, len(args)))
	}
	if query.RuleID != "" {
		add("rule_id = $%d", query.RuleID)
	}
	if query.SubjectType != "" {
		add("subject_type = $%d", query.SubjectType)
	}
	if query.SubjectID != "" {
		add("subject_id = $%d", query.SubjectID)
	}
	if len(query.Statuses) > 0 {
		placeholders := make([]string, 0, len(query.Statuses))
		for _, status := range query.Statuses {
			args = append(args, status)
			placeholders = append(placeholders, fmt.Sprintf("$%d", len(args)))
		}
		where = append(where, "status IN ("+strings.Join(placeholders, ", ")+")")
	}
	if !query.IncludeSuppressed {
		args = append(args, query.Now)
		where = append(where, fmt.Sprintf(
			"(status NOT IN ('false_positive', 'ignored') OR suppressed_until <= $%d)",
			len(args),
		))
	}
	args = append(args, query.Limit, query.Offset)
	statement := `
		SELECT ` + findingColumns + `
		FROM rhinoq_findings
		WHERE ` + strings.Join(where, " AND ") + `
		ORDER BY updated_at DESC, rule_id, subject_type, subject_id, invariant_version
		LIMIT $` + fmt.Sprint(len(args)-1) + ` OFFSET $` + fmt.Sprint(len(args))

	rows, err := s.db.QueryContext(ctx, statement, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	records := make([]finding.Record, 0, query.Limit)
	for rows.Next() {
		record, err := scanFinding(rows)
		if err != nil {
			return nil, err
		}
		records = append(records, record)
	}
	return records, rows.Err()
}

func (s *FindingStore) ListFindingEvents(
	ctx context.Context,
	key finding.Key,
	offset, limit int,
) ([]finding.Event, error) {
	if err := key.Validate(); err != nil {
		return nil, err
	}
	if offset < 0 || limit <= 0 || limit > 1000 {
		return nil, errors.New("event offset must be non-negative and limit must be between 1 and 1000")
	}
	rows, err := s.db.QueryContext(ctx, `
		SELECT sequence, rule_id, subject_type, subject_id, invariant_version,
		       kind, from_status, to_status, actor, reason, evidence,
		       suppressed_until, occurred_at
		FROM rhinoq_finding_events
		WHERE rule_id = $1 AND subject_type = $2
		  AND subject_id = $3 AND invariant_version = $4
		ORDER BY sequence DESC
		LIMIT $5 OFFSET $6`,
		key.RuleID, key.SubjectType, key.SubjectID,
		key.ObservedInvariantVersion, limit, offset,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	events := make([]finding.Event, 0, limit)
	for rows.Next() {
		var event finding.Event
		var until sql.NullTime
		if err := rows.Scan(
			&event.Sequence, &event.RuleID, &event.SubjectType, &event.SubjectID,
			&event.ObservedInvariantVersion, &event.Kind,
			&event.FromStatus, &event.ToStatus, &event.Actor,
			&event.Reason, &event.Evidence, &until, &event.OccurredAt,
		); err != nil {
			return nil, err
		}
		if until.Valid {
			event.Until = until.Time
		}
		events = append(events, event)
	}
	return events, rows.Err()
}
