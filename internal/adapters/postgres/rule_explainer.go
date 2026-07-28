package postgres

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/madebyduy/RhinoQ/internal/domain/rule"
	"github.com/madebyduy/RhinoQ/internal/ports"
)

var _ ports.RuleExplainer = (*RuleExplainer)(nil)

type RuleExplainer struct {
	db  *sql.DB
	now func() time.Time
}

func NewRuleExplainer(db *sql.DB, now func() time.Time) (*RuleExplainer, error) {
	if db == nil {
		return nil, errors.New("postgres database is required")
	}
	if now == nil {
		now = func() time.Time { return time.Now().UTC() }
	}
	return &RuleExplainer{db: db, now: now}, nil
}

type explainEnvelope struct {
	Plan explainPlan `json:"Plan"`
}

type explainPlan struct {
	NodeType     string        `json:"Node Type"`
	RelationName string        `json:"Relation Name"`
	TotalCost    float64       `json:"Total Cost"`
	PlanRows     int64         `json:"Plan Rows"`
	Plans        []explainPlan `json:"Plans"`
}

func (e *RuleExplainer) ExplainRule(
	ctx context.Context,
	record rule.Record,
) (rule.Explanation, error) {
	record = record.WithDefaults()
	if err := record.Validate(); err != nil {
		return rule.Explanation{}, err
	}
	tx, err := e.db.BeginTx(ctx, &sql.TxOptions{
		Isolation: sql.LevelReadCommitted,
		ReadOnly:  true,
	})
	if err != nil {
		return rule.Explanation{}, err
	}
	defer tx.Rollback()

	if _, err := tx.ExecContext(
		ctx,
		`SELECT set_config('statement_timeout', $1, true)`,
		fmt.Sprintf("%dms", record.StatementTimeout.Milliseconds()),
	); err != nil {
		return rule.Explanation{}, err
	}
	parameters := []any{"rhinoq-explain-subject"}
	if record.Scope == rule.TableScope {
		parameters = []any{record.BaselineAt, "", record.MaxRows}
		if strings.Contains(record.Query, "$4") {
			parameters = append(parameters, "")
		}
		if strings.Contains(record.Query, "$5") {
			// Explain plans the first page, so the cursor timestamp is the
			// baseline: that is the plan a scheduler actually executes when it
			// starts a walk.
			parameters = append(parameters, record.BaselineAt)
		}
	}
	wrapped := `SELECT * FROM (` + record.Query + `) AS rhinoq_rule_result LIMIT ` +
		fmt.Sprint(record.MaxRows)

	columns, err := explainColumns(ctx, tx, wrapped, parameters...)
	if err != nil {
		return rule.Explanation{}, fmt.Errorf(
			"explain rule result contract (cast job subject comparisons to text when needed): %w",
			err,
		)
	}
	var raw []byte
	if err := tx.QueryRowContext(
		ctx,
		`EXPLAIN (FORMAT JSON) `+wrapped,
		parameters...,
	).Scan(&raw); err != nil {
		return rule.Explanation{}, err
	}
	var envelopes []explainEnvelope
	if err := json.Unmarshal(raw, &envelopes); err != nil {
		return rule.Explanation{}, fmt.Errorf("decode PostgreSQL explain plan: %w", err)
	}
	if len(envelopes) != 1 {
		return rule.Explanation{}, errors.New("PostgreSQL returned an empty explain plan")
	}
	hash := sha256.Sum256([]byte(strings.TrimSpace(record.Query)))
	explanation := rule.Explanation{
		Safe:          true,
		PlanCost:      envelopes[0].Plan.TotalCost,
		EstimatedRows: envelopes[0].Plan.PlanRows,
		ExplainedAt:   e.now(),
		QueryHash:     hex.EncodeToString(hash[:]),
	}
	// The first three columns are positional; anything after them is optional
	// and matched by name. A Rule that never reports unknown has nothing to say
	// about unknown_reason, and one that walks by subject id has nothing to say
	// about changed_at, so requiring either would invalidate the other.
	shapeOK := len(columns) >= 3 &&
		columns[0] == "subject_id" && columns[1] == "violated" &&
		columns[2] == "evidence"
	seen := make(map[string]bool, len(columns))
	if shapeOK {
		for _, name := range columns[3:] {
			if (name != "unknown_reason" && name != "changed_at") || seen[name] {
				shapeOK = false
				break
			}
			seen[name] = true
		}
	}
	if !shapeOK {
		explanation.Reasons = append(
			explanation.Reasons,
			"query must return subject_id, violated, evidence and optionally unknown_reason and changed_at",
		)
	}
	// A changed-since Rule that cannot report when a subject changed cannot
	// resume, so it would silently restart its walk on every page and never
	// finish. Catching that at enable time is the whole purpose of this gate.
	if record.Cursor == rule.CursorChanged && !seen["changed_at"] {
		explanation.Reasons = append(
			explanation.Reasons,
			"changed-since rule must return changed_at, and page on ($5, $2) in that order",
		)
	}
	if explanation.PlanCost > record.MaxPlanCost {
		explanation.Reasons = append(explanation.Reasons, fmt.Sprintf(
			"plan cost %.2f exceeds budget %.2f",
			explanation.PlanCost, record.MaxPlanCost,
		))
	}
	collectSeqScans(envelopes[0].Plan, &explanation.SeqScans)
	for _, scan := range explanation.SeqScans {
		if scan.EstimatedRows > record.MaxSeqScanRows {
			explanation.Reasons = append(explanation.Reasons, fmt.Sprintf(
				"sequential scan on %s estimates %d rows, budget is %d",
				scan.Relation, scan.EstimatedRows, record.MaxSeqScanRows,
			))
		}
	}
	explanation.Safe = len(explanation.Reasons) == 0
	if err := tx.Commit(); err != nil {
		return rule.Explanation{}, err
	}
	return explanation, nil
}

func explainColumns(
	ctx context.Context,
	tx *sql.Tx,
	wrapped string,
	parameters ...any,
) ([]string, error) {
	rows, err := tx.QueryContext(ctx, `SELECT * FROM (`+wrapped+`) AS shape LIMIT 0`, parameters...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return rows.Columns()
}

func collectSeqScans(plan explainPlan, result *[]rule.SeqScan) {
	if plan.NodeType == "Seq Scan" {
		relation := plan.RelationName
		if relation == "" {
			relation = "unknown relation"
		}
		*result = append(*result, rule.SeqScan{
			Relation: relation, EstimatedRows: plan.PlanRows,
		})
	}
	for _, child := range plan.Plans {
		collectSeqScans(child, result)
	}
}
