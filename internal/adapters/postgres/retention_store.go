package postgres

import (
	"context"
	"database/sql"
	"errors"
	"strings"
	"time"

	"github.com/madebyduy/RhinoQ/internal/ports"
)

var _ ports.RetentionStore = (*RetentionStore)(nil)

type RetentionStore struct {
	db *sql.DB
}

func NewRetentionStore(db *sql.DB) (*RetentionStore, error) {
	if db == nil {
		return nil, errors.New("postgres database is required")
	}
	return &RetentionStore{db: db}, nil
}

// retentionTarget binds one prunable population to the statements that count
// and delete it. Keeping the count and the delete next to each other is what
// stops a plan from describing something different to what runs.
type retentionTarget struct {
	table string
	what  string
	// count and remove both take (cutoff, ruleID) and must agree on the
	// predicate. remove additionally takes a batch limit.
	count  string
	remove string
}

// retentionTargets is deliberately conservative. It reclaims observations that
// only exist to prove a subject was fine, and delivery/lifecycle evidence whose
// Finding is already resolved. It never touches an open Finding, a repair, a
// ProviderOperation or anything an audit or dispute could still need.
var retentionTargets = []retentionTarget{
	{
		table: "rhinoq_subject_outcomes",
		what:  "passing observations not seen since the cutoff",
		count: `
			SELECT count(*) FROM rhinoq_subject_outcomes
			WHERE status = 'passed' AND last_observed_at < $1
			  AND ($2 = '' OR rule_id = $2)`,
		remove: `
			DELETE FROM rhinoq_subject_outcomes
			WHERE (rule_id, rule_version, subject_type, subject_id) IN (
				SELECT rule_id, rule_version, subject_type, subject_id
				FROM rhinoq_subject_outcomes
				WHERE status = 'passed' AND last_observed_at < $1
				  AND ($2 = '' OR rule_id = $2)
				LIMIT $3
			)`,
	},
	{
		table: "rhinoq_finding_events",
		what:  "lifecycle history of Findings resolved before the cutoff",
		count: `
			SELECT count(*) FROM rhinoq_finding_events e
			WHERE e.occurred_at < $1 AND ($2 = '' OR e.rule_id = $2)
			  AND EXISTS (
				SELECT 1 FROM rhinoq_findings f
				WHERE f.rule_id = e.rule_id AND f.subject_type = e.subject_type
				  AND f.subject_id = e.subject_id
				  AND f.invariant_version = e.invariant_version
				  AND f.status = 'resolved' AND f.resolved_at < $1
			)`,
		remove: `
			DELETE FROM rhinoq_finding_events
			WHERE sequence IN (
				SELECT e.sequence FROM rhinoq_finding_events e
				WHERE e.occurred_at < $1 AND ($2 = '' OR e.rule_id = $2)
				  AND EXISTS (
					SELECT 1 FROM rhinoq_findings f
					WHERE f.rule_id = e.rule_id AND f.subject_type = e.subject_type
					  AND f.subject_id = e.subject_id
					  AND f.invariant_version = e.invariant_version
					  AND f.status = 'resolved' AND f.resolved_at < $1
				)
				LIMIT $3
			)`,
	},
	{
		table: "rhinoq_notification_deliveries",
		what:  "settled delivery ledger entries older than the cutoff",
		// A pending delivery is never pruned at any age: the ledger is what
		// stops a retry from sending an operator the same page twice.
		count: `
			SELECT count(*) FROM rhinoq_notification_deliveries
			WHERE state <> 'pending' AND updated_at < $1 AND ($2 = '' OR $2 <> '')`,
		remove: `
			DELETE FROM rhinoq_notification_deliveries
			WHERE id IN (
				SELECT id FROM rhinoq_notification_deliveries
				WHERE state <> 'pending' AND updated_at < $1 AND ($2 = '' OR $2 <> '')
				LIMIT $3
			)`,
	},
}

func validateRetention(cutoff time.Time, ruleID string) (string, error) {
	if cutoff.IsZero() {
		return "", errors.New("retention requires a cutoff")
	}
	return strings.TrimSpace(ruleID), nil
}

func (s *RetentionStore) PlanRetention(
	ctx context.Context,
	cutoff time.Time,
	ruleID string,
) (ports.RetentionPlan, error) {
	rule, err := validateRetention(cutoff, ruleID)
	if err != nil {
		return ports.RetentionPlan{}, err
	}
	plan := ports.RetentionPlan{Cutoff: cutoff}
	for _, target := range retentionTargets {
		var rows int64
		if err := s.db.QueryRowContext(ctx, target.count, cutoff, rule).Scan(&rows); err != nil {
			return ports.RetentionPlan{}, err
		}
		plan.Targets = append(plan.Targets, ports.RetentionTarget{
			Table: target.table, What: target.what, Rows: rows,
		})
	}
	return plan, nil
}

func (s *RetentionStore) PruneRetention(
	ctx context.Context,
	cutoff time.Time,
	ruleID string,
	batch int,
) (ports.RetentionPlan, error) {
	rule, err := validateRetention(cutoff, ruleID)
	if err != nil {
		return ports.RetentionPlan{}, err
	}
	if batch < 1 {
		return ports.RetentionPlan{}, errors.New("retention batch must be at least 1")
	}
	plan := ports.RetentionPlan{Cutoff: cutoff}
	for _, target := range retentionTargets {
		var removed int64
		for {
			// Each statement is its own transaction. A long-running delete
			// holding one transaction open across millions of rows is what
			// makes retention create the vacuum pressure it was supposed to
			// relieve.
			result, err := s.db.ExecContext(ctx, target.remove, cutoff, rule, batch)
			if err != nil {
				return plan, err
			}
			affected, err := result.RowsAffected()
			if err != nil {
				return plan, err
			}
			removed += affected
			if affected < int64(batch) {
				break
			}
			if err := ctx.Err(); err != nil {
				plan.Targets = append(plan.Targets, ports.RetentionTarget{
					Table: target.table, What: target.what, Rows: removed,
				})
				return plan, err
			}
		}
		plan.Targets = append(plan.Targets, ports.RetentionTarget{
			Table: target.table, What: target.what, Rows: removed,
		})
	}
	return plan, nil
}
