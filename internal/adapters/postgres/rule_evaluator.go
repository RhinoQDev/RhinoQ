package postgres

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/rhinoq/rhinoq/internal/domain/rule"
	"github.com/rhinoq/rhinoq/internal/ports"
)

var _ ports.RuleEvaluator = (*RuleEvaluator)(nil)

type RuleEvaluator struct {
	db  *sql.DB
	now func() time.Time
}

func NewRuleEvaluator(db *sql.DB, now func() time.Time) (*RuleEvaluator, error) {
	if db == nil {
		return nil, errors.New("postgres database is required")
	}
	if now == nil {
		now = func() time.Time { return time.Now().UTC() }
	}
	return &RuleEvaluator{db: db, now: now}, nil
}

func (e *RuleEvaluator) EvaluateRule(
	ctx context.Context,
	record rule.Record,
	subjectID, cursor string,
) (rule.Evaluation, error) {
	record = record.WithDefaults()
	if err := record.Validate(); err != nil {
		return rule.Evaluation{}, err
	}
	if record.Status != rule.Enabled {
		return rule.Evaluation{}, errors.New("only an enabled rule can be evaluated")
	}
	parameters := []any{subjectID}
	if record.Scope == rule.JobScope && strings.TrimSpace(subjectID) == "" {
		return rule.Evaluation{}, errors.New("job-scoped rule requires a subject id")
	}
	if record.Scope == rule.TableScope {
		parameters = []any{record.BaselineAt, cursor, record.MaxRows}
	}
	tx, err := e.db.BeginTx(ctx, &sql.TxOptions{
		Isolation: sql.LevelReadCommitted,
		ReadOnly:  true,
	})
	if err != nil {
		return rule.Evaluation{}, err
	}
	defer tx.Rollback()
	if _, err := tx.ExecContext(
		ctx,
		`SELECT set_config('statement_timeout', $1, true)`,
		fmt.Sprintf("%dms", record.StatementTimeout.Milliseconds()),
	); err != nil {
		return rule.Evaluation{}, err
	}
	wrapped := `SELECT * FROM (` + record.Query + `) AS rhinoq_rule_result LIMIT ` +
		fmt.Sprint(record.MaxRows)
	rows, err := tx.QueryContext(ctx, wrapped, parameters...)
	if err != nil {
		return rule.Evaluation{}, err
	}
	defer rows.Close()
	result := rule.Evaluation{
		Observations: make([]rule.Observation, 0, record.MaxRows),
		EvaluatedAt:  e.now(),
	}
	previous := cursor
	for rows.Next() {
		var observation rule.Observation
		var evidence []byte
		if err := rows.Scan(
			&observation.SubjectID, &observation.Violated, &evidence,
		); err != nil {
			return rule.Evaluation{}, err
		}
		observation.Evidence = string(evidence)
		if err := observation.Validate(); err != nil {
			return rule.Evaluation{}, err
		}
		if record.Scope == rule.JobScope {
			if observation.SubjectID != subjectID || len(result.Observations) > 0 {
				return rule.Evaluation{}, errors.New(
					"job-scoped rule must return at most one row for the requested subject",
				)
			}
		} else if observation.SubjectID <= previous {
			return rule.Evaluation{}, errors.New(
				"table-scoped rule must return subject_id in strict ascending cursor order",
			)
		}
		previous = observation.SubjectID
		result.Observations = append(result.Observations, observation)
	}
	if err := rows.Err(); err != nil {
		return rule.Evaluation{}, err
	}
	if err := rows.Close(); err != nil {
		return rule.Evaluation{}, err
	}
	if record.Scope == rule.TableScope && len(result.Observations) > 0 {
		result.NextCursor = previous
		result.HasMore = len(result.Observations) == record.MaxRows
	}
	if err := tx.Commit(); err != nil {
		return rule.Evaluation{}, err
	}
	return result, nil
}
