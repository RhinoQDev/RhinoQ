package postgres

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/madebyduy/RhinoQ/internal/domain/rule"
	"github.com/madebyduy/RhinoQ/internal/ports"
)

var _ ports.RuleStore = (*RuleStore)(nil)

type RuleStore struct {
	db *sql.DB
}

func NewRuleStore(db *sql.DB) (*RuleStore, error) {
	if db == nil {
		return nil, errors.New("postgres database is required")
	}
	return &RuleStore{db: db}, nil
}

const ruleColumns = `id, version, name, scope, status, subject_type, job_name,
	query, baseline_at, every_ms, within_ms, max_rows, statement_timeout_ms,
	max_plan_cost, max_seq_scan_rows, on_unknown, unknown_grace_ms, cursor_mode,
	created_at, updated_at`

type ruleScanner interface {
	Scan(dest ...any) error
}

func scanRule(row ruleScanner) (rule.Record, error) {
	var record rule.Record
	var baseline sql.NullTime
	var everyMS, withinMS, timeoutMS, unknownGraceMS int64
	var cursorMode string
	var onUnknown string
	err := row.Scan(
		&record.ID, &record.Version, &record.Name, &record.Scope, &record.Status,
		&record.SubjectType, &record.JobName, &record.Query, &baseline,
		&everyMS, &withinMS, &record.MaxRows, &timeoutMS,
		&record.MaxPlanCost, &record.MaxSeqScanRows, &onUnknown, &unknownGraceMS,
		&cursorMode,
		&record.CreatedAt, &record.UpdatedAt,
	)
	if baseline.Valid {
		record.BaselineAt = baseline.Time
	}
	record.Every = time.Duration(everyMS) * time.Millisecond
	record.Within = time.Duration(withinMS) * time.Millisecond
	record.StatementTimeout = time.Duration(timeoutMS) * time.Millisecond
	record.OnUnknown = rule.UnknownPolicy(onUnknown)
	record.UnknownGrace = time.Duration(unknownGraceMS) * time.Millisecond
	record.Cursor = rule.CursorMode(cursorMode)
	return record, err
}

func (s *RuleStore) SaveRule(ctx context.Context, record rule.Record) (rule.Record, error) {
	record = record.WithDefaults()
	if err := record.Validate(); err != nil {
		return rule.Record{}, err
	}
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO rhinoq_rules (
			`+ruleColumns+`
		) VALUES (
			$1, $2, $3, $4, $5, $6, $7, $8, $9,
			$10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20
		)`,
		record.ID, record.Version, record.Name, record.Scope, record.Status,
		record.SubjectType, record.JobName, record.Query,
		nullableTime(record.BaselineAt), record.Every.Milliseconds(),
		record.Within.Milliseconds(), record.MaxRows,
		record.StatementTimeout.Milliseconds(), record.MaxPlanCost,
		record.MaxSeqScanRows, string(record.OnUnknown),
		record.UnknownGrace.Milliseconds(), string(record.Cursor),
		record.CreatedAt, record.UpdatedAt,
	)
	if err != nil {
		return rule.Record{}, err
	}
	return record, nil
}

func (s *RuleStore) GetRule(
	ctx context.Context,
	id string,
) (rule.Record, bool, error) {
	record, err := scanRule(s.db.QueryRowContext(ctx, `
		SELECT `+ruleColumns+`
		FROM rhinoq_rules
		WHERE id = $1
		ORDER BY version DESC
		LIMIT 1`, id))
	if errors.Is(err, sql.ErrNoRows) {
		return rule.Record{}, false, nil
	}
	return record, err == nil, err
}

func (s *RuleStore) GetRuleVersion(
	ctx context.Context,
	id string,
	version int,
) (rule.Record, bool, error) {
	if id == "" || version < 1 {
		return rule.Record{}, false, rule.ErrInvalidRule
	}
	record, err := scanRule(s.db.QueryRowContext(ctx, `
		SELECT `+ruleColumns+`
		FROM rhinoq_rules
		WHERE id = $1 AND version = $2`, id, version))
	if errors.Is(err, sql.ErrNoRows) {
		return rule.Record{}, false, nil
	}
	return record, err == nil, err
}

func (s *RuleStore) ListRules(
	ctx context.Context,
	query rule.Query,
) ([]rule.Record, error) {
	if err := query.Validate(); err != nil {
		return nil, err
	}
	where := []string{"1 = 1"}
	args := make([]any, 0, 8)
	if query.Scope != "" {
		args = append(args, query.Scope)
		where = append(where, fmt.Sprintf("scope = $%d", len(args)))
	}
	if query.SubjectType != "" {
		args = append(args, query.SubjectType)
		where = append(where, fmt.Sprintf("subject_type = $%d", len(args)))
	}
	if len(query.Statuses) > 0 {
		holders := make([]string, 0, len(query.Statuses))
		for _, status := range query.Statuses {
			args = append(args, status)
			holders = append(holders, fmt.Sprintf("$%d", len(args)))
		}
		where = append(where, "status IN ("+strings.Join(holders, ", ")+")")
	}
	args = append(args, query.Limit, query.Offset)
	source := `(
		SELECT DISTINCT ON (id) ` + ruleColumns + `
		FROM rhinoq_rules
		ORDER BY id, version DESC
	) AS selected_rules`
	if len(query.Statuses) > 0 {
		source = "rhinoq_rules AS selected_rules"
	}
	statement := `
		SELECT ` + ruleColumns + `
		FROM ` + source + `
		WHERE ` + strings.Join(where, " AND ") + `
		ORDER BY id, version DESC
		LIMIT $` + fmt.Sprint(len(args)-1) + ` OFFSET $` + fmt.Sprint(len(args))
	rows, err := s.db.QueryContext(ctx, statement, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	records := make([]rule.Record, 0, query.Limit)
	for rows.Next() {
		record, err := scanRule(rows)
		if err != nil {
			return nil, err
		}
		records = append(records, record)
	}
	return records, rows.Err()
}

func (s *RuleStore) SetRuleStatus(
	ctx context.Context,
	id string,
	version int,
	status rule.Status,
	at time.Time,
) (rule.Record, error) {
	if id == "" || version < 1 || !status.Valid() || at.IsZero() {
		return rule.Record{}, rule.ErrInvalidRule
	}
	tx, err := s.db.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelReadCommitted})
	if err != nil {
		return rule.Record{}, err
	}
	defer tx.Rollback()
	if status == rule.Enabled {
		if _, err := tx.ExecContext(ctx, `
			UPDATE rhinoq_rules
			SET status = 'disabled', updated_at = $3
			WHERE id = $1 AND version <> $2 AND status = 'enabled'`,
			id, version, at,
		); err != nil {
			return rule.Record{}, err
		}
	}
	record, err := scanRule(tx.QueryRowContext(ctx, `
		UPDATE rhinoq_rules
		SET status = $3, updated_at = $4
		WHERE id = $1 AND version = $2
		RETURNING `+ruleColumns, id, version, status, at))
	if errors.Is(err, sql.ErrNoRows) {
		return rule.Record{}, ports.ErrRuleNotFound
	}
	if err != nil {
		return rule.Record{}, err
	}
	if record.Scope == rule.TableScope {
		if status == rule.Enabled {
			if _, err := tx.ExecContext(ctx, `
				INSERT INTO rhinoq_rule_schedules (
					rule_id, rule_version, next_run_at
				) VALUES ($1, $2, clock_timestamp())
				ON CONFLICT (rule_id, rule_version) DO UPDATE
				SET next_run_at = clock_timestamp()`,
				id, version,
			); err != nil {
				return rule.Record{}, err
			}
		}
	}
	if err := tx.Commit(); err != nil {
		return rule.Record{}, err
	}
	return record, nil
}

// DeleteRule removes a Rule and everything derived from it in one transaction.
//
// Explanations, schedules and subject outcomes cascade from the definition, so
// they are counted before the delete rather than after it. Findings do not
// cascade: they are keyed by rule id as free text precisely so an operator
// decision survives a definition being rewritten, which is also why discarding
// them has to be asked for explicitly.
func (s *RuleStore) DeleteRule(
	ctx context.Context,
	request rule.DeleteRequest,
) (rule.Deletion, error) {
	if err := request.Validate(); err != nil {
		return rule.Deletion{}, err
	}
	tx, err := s.db.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelReadCommitted})
	if err != nil {
		return rule.Deletion{}, err
	}
	defer tx.Rollback()

	// version = 0 means every version; the same predicate is reused by each
	// dependent count so the plan cannot drift from what is deleted.
	const versionFilter = "($2 = 0 OR version = $2)"
	rows, err := tx.QueryContext(ctx, `
		SELECT version, status
		FROM rhinoq_rules
		WHERE id = $1 AND `+versionFilter+`
		ORDER BY version
		FOR UPDATE`, request.ID, request.Version)
	if err != nil {
		return rule.Deletion{}, err
	}
	deletion := rule.Deletion{RuleID: request.ID}
	for rows.Next() {
		var version int
		var status string
		if err := rows.Scan(&version, &status); err != nil {
			rows.Close()
			return rule.Deletion{}, err
		}
		deletion.Versions = append(deletion.Versions, version)
		if rule.Status(status) == rule.Enabled {
			deletion.EnabledVersions = append(deletion.EnabledVersions, version)
		}
	}
	if err := rows.Err(); err != nil {
		return rule.Deletion{}, err
	}
	if err := rows.Close(); err != nil {
		return rule.Deletion{}, err
	}
	if len(deletion.Versions) == 0 {
		return deletion, ports.ErrRuleNotFound
	}
	if len(deletion.EnabledVersions) > 0 {
		return deletion, rule.ErrRuleEnabled
	}

	for _, count := range []struct {
		into      *int
		statement string
	}{
		{&deletion.Explanations, `
			SELECT count(*) FROM rhinoq_rule_explanations
			WHERE rule_id = $1 AND ($2 = 0 OR rule_version = $2)`},
		{&deletion.Schedules, `
			SELECT count(*) FROM rhinoq_rule_schedules
			WHERE rule_id = $1 AND ($2 = 0 OR rule_version = $2)`},
		{&deletion.Outcomes, `
			SELECT count(*) FROM rhinoq_subject_outcomes
			WHERE rule_id = $1 AND ($2 = 0 OR rule_version = $2)`},
		{&deletion.Findings, `
			SELECT count(*) FROM rhinoq_findings
			WHERE rule_id = $1 AND ($2 = 0 OR invariant_version = $2)`},
		{&deletion.FindingEvents, `
			SELECT count(*) FROM rhinoq_finding_events
			WHERE rule_id = $1 AND ($2 = 0 OR invariant_version = $2)`},
	} {
		if err := tx.QueryRowContext(
			ctx, count.statement, request.ID, request.Version,
		).Scan(count.into); err != nil {
			return rule.Deletion{}, err
		}
	}
	if deletion.Findings > 0 && !request.PurgeFindings {
		return deletion, rule.ErrFindingsRemain
	}

	if request.PurgeFindings {
		// Events cascade from the Finding, so one delete is enough and the
		// counted history stays consistent with what actually disappears.
		if _, err := tx.ExecContext(ctx, `
			DELETE FROM rhinoq_findings
			WHERE rule_id = $1 AND ($2 = 0 OR invariant_version = $2)`,
			request.ID, request.Version,
		); err != nil {
			return rule.Deletion{}, err
		}
	} else {
		deletion.Findings, deletion.FindingEvents = 0, 0
	}
	// Subject outcomes used to disappear through ON DELETE CASCADE. That
	// foreign key cost one index probe into rhinoq_rules for every row written
	// during a scan, so it is gone and the delete is explicit. It runs inside
	// the same transaction, so a dry run still rolls it back and a real delete
	// cannot leave the outcomes of a removed Rule version behind.
	if _, err := tx.ExecContext(ctx, `
		DELETE FROM rhinoq_subject_outcomes
		WHERE rule_id = $1 AND ($2 = 0 OR rule_version = $2)`,
		request.ID, request.Version,
	); err != nil {
		return rule.Deletion{}, err
	}
	if _, err := tx.ExecContext(ctx, `
		DELETE FROM rhinoq_rules
		WHERE id = $1 AND `+versionFilter, request.ID, request.Version,
	); err != nil {
		return rule.Deletion{}, err
	}
	if request.DryRun {
		// The rollback in the deferred call is the point: the caller sees the
		// real cost of the delete without paying it.
		return deletion, nil
	}
	if err := tx.Commit(); err != nil {
		return rule.Deletion{}, err
	}
	deletion.Applied = true
	return deletion, nil
}

func (s *RuleStore) SaveRuleExplanation(
	ctx context.Context,
	id string,
	version int,
	explanation rule.Explanation,
) error {
	seqScans, err := json.Marshal(explanation.SeqScans)
	if err != nil {
		return err
	}
	reasons, err := json.Marshal(explanation.Reasons)
	if err != nil {
		return err
	}
	result, err := s.db.ExecContext(ctx, `
		INSERT INTO rhinoq_rule_explanations (
			rule_id, rule_version, query_hash, safe, plan_cost,
			estimated_rows, seq_scans, reasons, explained_at
		) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
		ON CONFLICT (rule_id, rule_version) DO UPDATE
		SET query_hash = EXCLUDED.query_hash, safe = EXCLUDED.safe,
		    plan_cost = EXCLUDED.plan_cost,
		    estimated_rows = EXCLUDED.estimated_rows,
		    seq_scans = EXCLUDED.seq_scans, reasons = EXCLUDED.reasons,
		    explained_at = EXCLUDED.explained_at`,
		id, version, explanation.QueryHash, explanation.Safe,
		explanation.PlanCost, explanation.EstimatedRows,
		seqScans, reasons, explanation.ExplainedAt,
	)
	if err != nil {
		return err
	}
	affected, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if affected != 1 {
		return ports.ErrRuleNotFound
	}
	return nil
}

func (s *RuleStore) GetRuleExplanation(
	ctx context.Context,
	id string,
	version int,
) (rule.Explanation, bool, error) {
	var explanation rule.Explanation
	var seqScans, reasons []byte
	err := s.db.QueryRowContext(ctx, `
		SELECT query_hash, safe, plan_cost, estimated_rows,
		       seq_scans, reasons, explained_at
		FROM rhinoq_rule_explanations
		WHERE rule_id = $1 AND rule_version = $2`,
		id, version,
	).Scan(
		&explanation.QueryHash, &explanation.Safe, &explanation.PlanCost,
		&explanation.EstimatedRows, &seqScans, &reasons,
		&explanation.ExplainedAt,
	)
	if errors.Is(err, sql.ErrNoRows) {
		return rule.Explanation{}, false, nil
	}
	if err != nil {
		return rule.Explanation{}, false, err
	}
	if err := json.Unmarshal(seqScans, &explanation.SeqScans); err != nil {
		return rule.Explanation{}, false, err
	}
	if err := json.Unmarshal(reasons, &explanation.Reasons); err != nil {
		return rule.Explanation{}, false, err
	}
	return explanation, true, nil
}

func (s *RuleStore) ClaimDueRules(
	ctx context.Context,
	owner string,
	now time.Time,
	leaseFor time.Duration,
	limit int,
) ([]rule.ScheduleLease, error) {
	if strings.TrimSpace(owner) == "" || now.IsZero() || leaseFor <= 0 ||
		limit <= 0 || limit > 100 {
		return nil, rule.ErrInvalidRule
	}
	tx, err := s.db.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelReadCommitted})
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	rows, err := tx.QueryContext(ctx, `
		WITH due AS (
			SELECT schedule.rule_id, schedule.rule_version
			FROM rhinoq_rule_schedules AS schedule
			JOIN rhinoq_rules AS definition
			  ON definition.id = schedule.rule_id
			 AND definition.version = schedule.rule_version
			WHERE definition.scope = 'table'
			  AND definition.status = 'enabled'
			  AND schedule.next_run_at <= clock_timestamp()
			  AND (
			      schedule.lease_expires_at IS NULL
			      OR schedule.lease_expires_at <= clock_timestamp()
			  )
			ORDER BY schedule.next_run_at, schedule.rule_id
			FOR UPDATE OF schedule SKIP LOCKED
			LIMIT $1
		)
		UPDATE rhinoq_rule_schedules AS schedule
		SET lease_owner = $2,
		    lease_epoch = schedule.lease_epoch + 1,
		    lease_expires_at = clock_timestamp() + $3::interval,
		    last_started_at = clock_timestamp(),
		    last_error = ''
		FROM due, rhinoq_rules AS definition
		WHERE schedule.rule_id = due.rule_id
		  AND schedule.rule_version = due.rule_version
		  AND definition.id = schedule.rule_id
		  AND definition.version = schedule.rule_version
		RETURNING schedule.rule_id, schedule.rule_version,
		          schedule.lease_epoch, schedule.cursor,
		          definition.every_ms, schedule.last_started_at,
		          schedule.lease_expires_at`,
		limit, owner, postgresInterval(leaseFor),
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	leases := make([]rule.ScheduleLease, 0, limit)
	for rows.Next() {
		var lease rule.ScheduleLease
		var everyMS int64
		if err := rows.Scan(
			&lease.RuleID, &lease.Version, &lease.Epoch, &lease.Cursor,
			&everyMS, &lease.ClaimedAt, &lease.ExpiresAt,
		); err != nil {
			return nil, err
		}
		lease.Owner = owner
		lease.Every = time.Duration(everyMS) * time.Millisecond
		leases = append(leases, lease)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if err := rows.Close(); err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return leases, nil
}

func (s *RuleStore) AdvanceRuleCursor(
	ctx context.Context,
	lease rule.ScheduleLease,
	cursor string,
) error {
	if err := lease.Validate(); err != nil {
		return err
	}
	if strings.TrimSpace(cursor) == "" {
		return rule.ErrInvalidRule
	}
	return requireScheduleUpdate(s.db.ExecContext(ctx, `
		UPDATE rhinoq_rule_schedules
		SET cursor = $4, next_run_at = clock_timestamp(), lease_owner = NULL,
		    lease_expires_at = NULL, last_error = ''
		WHERE rule_id = $1 AND rule_version = $2
		  AND lease_owner = $3 AND lease_epoch = $5`,
		lease.RuleID, lease.Version, lease.Owner, cursor, lease.Epoch,
	))
}

func (s *RuleStore) CompleteRuleRun(
	ctx context.Context,
	lease rule.ScheduleLease,
) error {
	if err := lease.Validate(); err != nil {
		return err
	}
	return requireScheduleUpdate(s.db.ExecContext(ctx, `
		UPDATE rhinoq_rule_schedules
		SET cursor = '', next_run_at = clock_timestamp() + $4::interval,
		    lease_owner = NULL, lease_expires_at = NULL,
		    last_completed_at = clock_timestamp(), last_error = ''
		WHERE rule_id = $1 AND rule_version = $2
		  AND lease_owner = $3 AND lease_epoch = $5`,
		lease.RuleID, lease.Version, lease.Owner,
		postgresInterval(lease.Every), lease.Epoch,
	))
}

func (s *RuleStore) FailRuleRun(
	ctx context.Context,
	lease rule.ScheduleLease,
	retryAfter time.Duration,
	message string,
) error {
	if len(message) > 4096 {
		message = message[:4096]
	}
	if err := lease.Validate(); err != nil || retryAfter <= 0 {
		if err != nil {
			return err
		}
		return rule.ErrInvalidRule
	}
	return requireScheduleUpdate(s.db.ExecContext(ctx, `
		UPDATE rhinoq_rule_schedules
		SET next_run_at = clock_timestamp() + $4::interval,
		    lease_owner = NULL, lease_expires_at = NULL,
		    last_error = $5
		WHERE rule_id = $1 AND rule_version = $2
		  AND lease_owner = $3 AND lease_epoch = $6`,
		lease.RuleID, lease.Version, lease.Owner,
		postgresInterval(retryAfter), message, lease.Epoch,
	))
}

func requireScheduleUpdate(result sql.Result, err error) error {
	if err != nil {
		return err
	}
	affected, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if affected != 1 {
		return rule.ErrScheduleLeaseLost
	}
	return nil
}

func postgresInterval(duration time.Duration) string {
	return fmt.Sprintf("%d milliseconds", duration.Milliseconds())
}
