package postgres_test

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/rhinoq/rhinoq/pkg/rhinoq"
)

func TestRuleMustPassPostgreSQLExplainBeforeEnable(t *testing.T) {
	client := newClient(t)
	createRuleFixture(t)
	definition := rhinoq.RuleDefinition{
		ID: "order-must-provision", Name: "Order must provision",
		Scope: rhinoq.RuleScopeTable, SubjectType: "order",
		Query: `SELECT id::text AS subject_id,
			status = 'paid' AS violated,
			jsonb_build_object('status', status) AS evidence
			FROM rhinoq_rule_test_orders
			WHERE created_at >= $1 AND id::text > $2
			ORDER BY id::text LIMIT $3`,
		BaselineAt: time.Date(2026, 7, 28, 0, 0, 0, 0, time.UTC),
		Every:      10 * time.Minute,
	}
	record, err := client.RegisterRule(context.Background(), definition)
	if err != nil {
		t.Fatal(err)
	}
	if record.Status != rhinoq.RuleDraft {
		t.Fatalf("new rule must be draft: %+v", record)
	}
	record, explanation, err := client.EnableRule(context.Background(), definition.ID)
	if err != nil {
		t.Fatalf("safe indexed rule should enable: explanation=%+v err=%v", explanation, err)
	}
	if !explanation.Safe || explanation.QueryHash == "" ||
		record.Status != rhinoq.RuleEnabled {
		t.Fatalf("enable must persist explain evidence: rule=%+v explain=%+v", record, explanation)
	}

	evaluation, err := client.EvaluateRule(
		context.Background(), definition.ID, "", "",
	)
	if err != nil {
		t.Fatalf("evaluate enabled table rule: %v", err)
	}
	if len(evaluation.Observations) != 50 || len(evaluation.Findings) != 25 ||
		evaluation.HasMore {
		t.Fatalf("evaluation must turn only violations into findings: %+v", evaluation)
	}
	if _, err := testDB.Exec(`
		UPDATE rhinoq_rule_test_orders SET status = 'pending'`); err != nil {
		t.Fatal(err)
	}
	evaluation, err = client.EvaluateRule(
		context.Background(), definition.ID, "", "",
	)
	if err != nil {
		t.Fatalf("re-evaluate passing subjects: %v", err)
	}
	if len(evaluation.Findings) != 25 {
		t.Fatalf("all previously open findings must auto-resolve: %+v", evaluation.Findings)
	}
	resolved, err := client.ListFindings(context.Background(), rhinoq.FindingQuery{
		RuleID: definition.ID, Statuses: []string{rhinoq.FindingResolved}, Limit: 100,
	})
	if err != nil || len(resolved) != 25 {
		t.Fatalf("expected 25 resolved findings: len=%d err=%v", len(resolved), err)
	}
	next, err := client.RegisterRule(context.Background(), definition)
	if err != nil || next.Version != 2 || next.Status != rhinoq.RuleDraft {
		t.Fatalf("new definition must append a draft version: rule=%+v err=%v", next, err)
	}
	enabled, err := client.ListRules(context.Background(), rhinoq.RuleQuery{
		Statuses: []string{rhinoq.RuleEnabled}, Limit: 20,
	})
	if err != nil || len(enabled) != 1 || enabled[0].Version != 1 {
		t.Fatalf("active v1 must stay discoverable while v2 is draft: rules=%+v err=%v", enabled, err)
	}
}

func TestRuleExplainBlocksCostAndResultShapeViolations(t *testing.T) {
	client := newClient(t)
	createRuleFixture(t)
	_, err := client.RegisterRule(context.Background(), rhinoq.RuleDefinition{
		ID: "unsafe-order-rule", Name: "Unsafe order rule",
		Scope: rhinoq.RuleScopeTable, SubjectType: "order",
		Query: `SELECT id::text AS wrong_name,
			status = 'paid' AS violated,
			jsonb_build_object('status', status) AS evidence
			FROM rhinoq_rule_test_orders
			WHERE created_at >= $1 AND id::text > $2
			ORDER BY id::text LIMIT $3`,
		BaselineAt: time.Date(2026, 7, 28, 0, 0, 0, 0, time.UTC),
		Every:      10 * time.Minute, MaxPlanCost: 0.0001,
	})
	if err != nil {
		t.Fatal(err)
	}
	record, explanation, err := client.EnableRule(context.Background(), "unsafe-order-rule")
	if !errors.Is(err, rhinoq.ErrRuleUnsafe) {
		t.Fatalf("unsafe rule must be refused: rule=%+v explain=%+v err=%v", record, explanation, err)
	}
	if explanation.Safe || len(explanation.Reasons) < 2 ||
		record.Status != rhinoq.RuleDraft {
		t.Fatalf("shape and cost violations must keep draft with reasons: rule=%+v explain=%+v", record, explanation)
	}
}

func createRuleFixture(t *testing.T) {
	t.Helper()
	if _, err := testDB.Exec(`
		DROP TABLE IF EXISTS rhinoq_rule_test_orders;
		CREATE TABLE rhinoq_rule_test_orders (
			id bigint PRIMARY KEY,
			status text NOT NULL,
			created_at timestamptz NOT NULL
		);
		CREATE INDEX rhinoq_rule_test_orders_created_idx
			ON rhinoq_rule_test_orders (created_at, status);
		INSERT INTO rhinoq_rule_test_orders (id, status, created_at)
		SELECT number, CASE WHEN number % 2 = 0 THEN 'paid' ELSE 'pending' END,
		       now() - number * interval '1 minute'
		FROM generate_series(1, 50) AS number`); err != nil {
		t.Fatalf("create rule fixture: %v", err)
	}
}
