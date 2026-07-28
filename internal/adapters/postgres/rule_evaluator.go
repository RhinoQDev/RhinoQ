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
	cursorChangedAt, cursorSubject := rule.DecodeCursor(cursor)
	if record.Scope == rule.TableScope {
		parameters = []any{record.BaselineAt, cursorSubject, record.MaxRows}
		if strings.Contains(record.Query, "$4") {
			parameters = append(parameters, subjectID)
		} else if strings.TrimSpace(subjectID) != "" {
			return rule.Evaluation{}, errors.New(
				"table Rule is not signal-capable: add a $4 subject filter",
			)
		}
		if record.Cursor == rule.CursorChanged {
			if !strings.Contains(record.Query, "$5") {
				return rule.Evaluation{}, errors.New(
					"changed-since Rule must page on $5, the cursor timestamp, together with $2")
			}
			if len(parameters) == 3 {
				return rule.Evaluation{}, errors.New(
					"changed-since Rule must also accept $4, the single subject filter")
			}
			// An empty cursor starts at the baseline rather than at the epoch,
			// so a changed-since walk never claims to have looked at history
			// the Rule was never meant to cover.
			if cursorChangedAt.IsZero() {
				cursorChangedAt = record.BaselineAt
			}
			parameters = append(parameters, cursorChangedAt)
		}
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
	// Optional columns are matched by name, not position. Two of them exist now
	// and they are independent, so requiring a fixed order would force a Rule
	// that wants one to declare the other.
	optional := make(map[string]int, len(columns))
	for index, name := range columns[min(len(columns), 3):] {
		optional[name] = index + 3
	}
	if record.Cursor == rule.CursorChanged {
		if _, found := optional["changed_at"]; !found {
			return rule.Evaluation{}, errors.New(
				"changed-since Rule must return changed_at so its cursor can resume")
		}
	}

	result := rule.Evaluation{
		Observations: make([]rule.Observation, 0, record.MaxRows),
		EvaluatedAt:  e.now(),
	}
	previous := cursorSubject
	previousChangedAt := cursorChangedAt
	var lastChangedAt time.Time
	for rows.Next() {
		var observation rule.Observation
		var evidence []byte
		// NULL is how a query says it could not decide. Scanning into a bool
		// would turn that into an error, which is why a check that cannot reach
		// its provider currently has no way to say so.
		var violated sql.NullBool
		var reason sql.NullString
		var changedAt sql.NullTime
		targets := make([]any, len(columns))
		targets[0] = &observation.SubjectID
		targets[1] = &violated
		targets[2] = &evidence
		for index := 3; index < len(columns); index++ {
			switch columns[index] {
			case "unknown_reason":
				targets[index] = &reason
			case "changed_at":
				targets[index] = &changedAt
			default:
				return rule.Evaluation{}, fmt.Errorf(
					"rule query returned an unrecognised column %q", columns[index])
			}
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
		} else if record.Cursor == rule.CursorChanged {
			// Paging on a timestamp alone silently skips rows that share one.
			// For an integrity checker that means reporting a table clean
			// because it never looked, so the composite order is enforced
			// rather than assumed.
			if !changedAt.Valid {
				return rule.Evaluation{}, errors.New(
					"changed-since Rule must return a non-null changed_at for every row")
			}
			if changedAt.Time.Before(previousChangedAt) ||
				(changedAt.Time.Equal(previousChangedAt) && observation.SubjectID <= previous) {
				return rule.Evaluation{}, errors.New(
					"changed-since Rule must return (changed_at, subject_id) in strict ascending cursor order",
				)
			}
			previousChangedAt = changedAt.Time
			lastChangedAt = changedAt.Time
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
		if record.Cursor == rule.CursorChanged {
			result.NextCursor = rule.EncodeCursor(lastChangedAt, previous)
		}
		result.HasMore = len(result.Observations) == record.MaxRows
	}
	if err := tx.Commit(); err != nil {
		return rule.Evaluation{}, err
	}
	return result, nil
}
