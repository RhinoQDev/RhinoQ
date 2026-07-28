package unit_test

import (
	"errors"
	"testing"
	"time"

	"github.com/madebyduy/RhinoQ/internal/domain/rule"
)

func TestTableRuleRequiresBaselineIntervalAndBoundedSelect(t *testing.T) {
	record := rule.Record{
		ID: "order-must-provision", Version: 1, Name: "Order must provision",
		Scope: rule.TableScope, Status: rule.Draft, SubjectType: "order",
		Query: `SELECT id::text AS subject_id, true AS violated,
			'{}'::jsonb AS evidence
			FROM orders WHERE created_at >= $1 AND id::text > $2
			ORDER BY id::text LIMIT $3`,
	}
	record = record.WithDefaults()
	if !errors.Is(record.Validate(), rule.ErrBaselineRequired) {
		t.Fatalf("table rule without a baseline must fail, got %v", record.Validate())
	}
	record.BaselineAt = time.Now().UTC()
	if !errors.Is(record.Validate(), rule.ErrIntervalRequired) {
		t.Fatalf("table rule without an interval must fail, got %v", record.Validate())
	}
	record.Every = 10 * time.Minute
	if err := record.Validate(); err != nil {
		t.Fatalf("valid table rule: %v", err)
	}
}

func TestRuleQueryRejectsMultipleStatementsAndComments(t *testing.T) {
	queries := []string{
		`DELETE FROM orders WHERE id = $1`,
		`SELECT id FROM orders WHERE id = $1; DROP TABLE orders`,
		`SELECT id FROM orders -- $1`,
		`SELECT id FROM orders`,
	}
	for _, query := range queries {
		if !errors.Is(rule.ValidateQuery(query), rule.ErrUnsafeQuery) {
			t.Fatalf("unsafe query should be rejected: %s", query)
		}
	}
}
