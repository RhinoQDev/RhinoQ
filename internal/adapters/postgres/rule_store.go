package postgres

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/rhinoq/rhinoq/internal/domain/rule"
	"github.com/rhinoq/rhinoq/internal/ports"
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
	max_plan_cost, max_seq_scan_rows, created_at, updated_at`

type ruleScanner interface {
	Scan(dest ...any) error
}

func scanRule(row ruleScanner) (rule.Record, error) {
	var record rule.Record
	var baseline sql.NullTime
	var everyMS, withinMS, timeoutMS int64
	err := row.Scan(
		&record.ID, &record.Version, &record.Name, &record.Scope, &record.Status,
		&record.SubjectType, &record.JobName, &record.Query, &baseline,
		&everyMS, &withinMS, &record.MaxRows, &timeoutMS,
		&record.MaxPlanCost, &record.MaxSeqScanRows,
		&record.CreatedAt, &record.UpdatedAt,
	)
	if baseline.Valid {
		record.BaselineAt = baseline.Time
	}
	record.Every = time.Duration(everyMS) * time.Millisecond
	record.Within = time.Duration(withinMS) * time.Millisecond
	record.StatementTimeout = time.Duration(timeoutMS) * time.Millisecond
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
			$10, $11, $12, $13, $14, $15, $16, $17
		)`,
		record.ID, record.Version, record.Name, record.Scope, record.Status,
		record.SubjectType, record.JobName, record.Query,
		nullableTime(record.BaselineAt), record.Every.Milliseconds(),
		record.Within.Milliseconds(), record.MaxRows,
		record.StatementTimeout.Milliseconds(), record.MaxPlanCost,
		record.MaxSeqScanRows, record.CreatedAt, record.UpdatedAt,
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
	if err := tx.Commit(); err != nil {
		return rule.Record{}, err
	}
	return record, nil
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
