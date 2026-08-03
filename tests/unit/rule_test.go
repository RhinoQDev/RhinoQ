package unit_test

import (
	"encoding/json"
	"errors"
	"os"
	"reflect"
	"testing"
	"time"

	"github.com/madebyduy/RhinoQ/internal/domain/rule"
	"github.com/madebyduy/RhinoQ/pkg/rhinoq"
)

func TestRuleRecordUsesStablePublicJSONContract(t *testing.T) {
	golden, err := os.ReadFile("../../testdata/contracts/rule-record-v1.json")
	if err != nil {
		t.Fatalf("read Rule Record golden fixture: %v", err)
	}
	created := time.Date(2026, 8, 3, 2, 54, 57, 46_000_000, time.UTC)
	record := rhinoq.RuleRecord{
		RuleDefinition: rhinoq.RuleDefinition{
			ID: "completed-report-has-output", Name: "Completed Report Has Output",
			Scope: rhinoq.RuleScopeTable, SubjectType: "report",
			Query:      "SELECT id::text AS subject_id, output_url IS NULL AS violated,\n       jsonb_build_object('status', status, 'hasOutput', output_url IS NOT NULL) AS evidence\nFROM completed_reports\nWHERE created_at >= $1\n  AND id::text > $2\nORDER BY id\nLIMIT $3\n",
			BaselineAt: created, Every: 5 * time.Minute, MaxRows: 500,
			OnUnknown: rhinoq.UnknownRetries, Cursor: rhinoq.CursorSubject,
			StatementTimeout: 5 * time.Second, MaxPlanCost: 100_000,
			MaxSeqScanRows: 10_000,
		},
		Version: 1, Status: rhinoq.RuleDraft, CreatedAt: created, UpdatedAt: created,
	}
	actual, err := json.MarshalIndent(record, "", "  ")
	if err != nil {
		t.Fatalf("marshal Rule Record: %v", err)
	}
	var actualValue any
	var expectedValue any
	if err := json.Unmarshal(actual, &actualValue); err != nil {
		t.Fatalf("decode actual Rule Record JSON: %v", err)
	}
	if err := json.Unmarshal(golden, &expectedValue); err != nil {
		t.Fatalf("decode golden Rule Record JSON: %v", err)
	}
	if !reflect.DeepEqual(actualValue, expectedValue) {
		t.Fatalf("Rule Record JSON drifted from the shared wire fixture\nactual:\n%s\nexpected:\n%s", actual, golden)
	}
}

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

func TestNodeRuleTemplateSatisfiesCanonicalRuleContract(t *testing.T) {
	query, err := os.ReadFile("../../testdata/rules/completed-report-has-output.sql")
	if err != nil {
		t.Fatalf("read shared Node Rule template: %v", err)
	}
	if err := rule.ValidateQuery(string(query)); err != nil {
		t.Fatalf("Node Rule template must pass ValidateQuery: %v", err)
	}
	record := rule.Record{
		ID: "completed-report-has-output", Version: 1,
		Name: "Completed reports have an output", Scope: rule.TableScope,
		Status: rule.Draft, SubjectType: "report", Query: string(query),
		BaselineAt: time.Now().UTC(), Every: time.Minute,
	}
	if err := record.WithDefaults().Validate(); err != nil {
		t.Fatalf("Node Rule template must pass the table Rule contract: %v", err)
	}
}
