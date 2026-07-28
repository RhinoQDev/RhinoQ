package postgres

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/madebyduy/RhinoQ/internal/domain/rule"
	"github.com/madebyduy/RhinoQ/internal/ports"
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
	columns, err := rows.Columns()
	if err != nil {
		return rule.Evaluation{}, err
	}
	// The fourth column is optional so existing three-column Rules keep working.
	// It is only read when violated is NULL, because a reason on a conclusive
	// observation would be describing something the model does not carry.
	withReason := len(columns) == 4
	result := rule.Evaluation{
		Observations: make([]rule.Observation, 0, record.MaxRows),
		EvaluatedAt:  e.now(),
	}
	previous := cursor
	for rows.Next() {
		var observation rule.Observation
		var evidence []byte
		// NULL is how a query says it could not decide. Scanning into a bool
		// would turn that into an error, which is why a check that cannot reach
		// its provider currently has no way to say so.
		var violated sql.NullBool
		var reason sql.NullString
		targets := []any{&observation.SubjectID, &violated, &evidence}
		if withReason {
			targets = append(targets, &reason)
		}
		if err := rows.Scan(targets...); err != nil {
			return rule.Evaluation{}, err
		}
		observation.Evidence = string(evidence)
		switch {
		case !violated.Valid:
			observation.Status = rule.Unknown
			observation.Reason = strings.TrimSpace(reason.String)
			if observation.Reason == "" {
				// An unlabelled unknown is still worth keeping: dropping the
				// observation would silently restore the boolean behaviour.
				observation.Reason = rule.UnknownUnspecified
			}
		case violated.Bool:
			observation.Status = rule.Violated
		default:
			observation.Status = rule.Passed
		}
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
