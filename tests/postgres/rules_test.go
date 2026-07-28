package postgres_test

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	postgresadapter "github.com/madebyduy/RhinoQ/internal/adapters/postgres"
	"github.com/madebyduy/RhinoQ/internal/domain/rule"
	"github.com/madebyduy/RhinoQ/pkg/rhinoq"
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

func TestRuleScheduleCursorSurvivesCrashAndRejectsStaleOwner(t *testing.T) {
	client := newClient(t)
	createRuleFixture(t)
	_, err := client.RegisterRule(context.Background(), rhinoq.RuleDefinition{
		ID: "scheduled-order-rule", Name: "Scheduled order rule",
		Scope: rhinoq.RuleScopeTable, SubjectType: "order",
		Query: `SELECT id::text AS subject_id, status = 'paid' AS violated,
			'{}'::jsonb AS evidence FROM rhinoq_rule_test_orders
			WHERE created_at >= $1 AND id::text > $2
			ORDER BY id::text LIMIT $3`,
		BaselineAt: time.Date(2026, 7, 28, 0, 0, 0, 0, time.UTC),
		Every:      time.Minute, MaxRows: 10,
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := client.EnableRule(context.Background(), "scheduled-order-rule"); err != nil {
		t.Fatal(err)
	}
	store, err := postgresadapter.NewRuleStore(testDB)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC()
	first, err := store.ClaimDueRules(
		context.Background(), "scheduler-a", now, time.Second, 1,
	)
	if err != nil || len(first) != 1 {
		t.Fatalf("first scheduler must claim the due rule: leases=%+v err=%v", first, err)
	}
	if err := store.AdvanceRuleCursor(
		context.Background(), first[0], "10",
	); err != nil {
		t.Fatal(err)
	}
	second, err := store.ClaimDueRules(
		context.Background(), "scheduler-b", now, time.Second, 1,
	)
	if err != nil || len(second) != 1 || second[0].Cursor != "10" ||
		second[0].Epoch <= first[0].Epoch {
		t.Fatalf("replacement scheduler must resume a fenced cursor: leases=%+v err=%v", second, err)
	}
	if err := store.CompleteRuleRun(
		context.Background(), first[0],
	); !errors.Is(err, rule.ErrScheduleLeaseLost) {
		t.Fatalf("stale scheduler must not complete a newer lease: %v", err)
	}
	if _, err := client.DisableRule(
		context.Background(), "scheduled-order-rule",
	); err != nil {
		t.Fatal(err)
	}
	if err := store.CompleteRuleRun(
		context.Background(), second[0],
	); err != nil {
		t.Fatalf("a page claimed before disable must be allowed to finish: %v", err)
	}
	afterDisable, err := store.ClaimDueRules(
		context.Background(), "scheduler-c", now.Add(time.Hour), time.Second, 1,
	)
	if err != nil || len(afterDisable) != 0 {
		t.Fatalf("disabled Rule must not be claimed again: leases=%+v err=%v", afterDisable, err)
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

// The integrity-only journey end to end against a real database: connect,
// register a Rule, explain it, enable it, scan, and get Findings - with no
// queue, no worker and no job ever created.
func TestIntegrityOnlyScanProducesFindingsWithoutAQueue(t *testing.T) {
	if testDB == nil {
		t.Skip("set RHINOQ_TEST_DATABASE_URL to run the PostgreSQL harness")
	}
	truncate(t)
	createRuleFixture(t)

	integrity, err := rhinoq.NewIntegrity(testDB)
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	definition := rhinoq.RuleDefinition{
		ID: "paid-order-must-provision", Name: "Paid order must provision",
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
	if _, err := integrity.RegisterRule(ctx, definition); err != nil {
		t.Fatalf("register through the integrity facade: %v", err)
	}
	if _, explanation, err := integrity.EnableRule(ctx, definition.ID); err != nil {
		t.Fatalf("enable through the integrity facade: explanation=%+v err=%v", explanation, err)
	}

	summary, err := integrity.Scan(ctx, rhinoq.ScanRequest{RuleID: definition.ID})
	if err != nil {
		t.Fatalf("scan: %v", err)
	}
	if summary.Observed != 50 || summary.Violated != 25 || summary.Passed != 25 {
		t.Fatalf("the fixture has 25 violating orders of 50: %+v", summary)
	}
	if summary.HasMore {
		t.Fatalf("a 50 row fixture must complete inside the default page budget: %+v", summary)
	}
	if summary.Findings != 25 {
		t.Fatalf("each violation must fold into a Finding: %+v", summary)
	}

	findings, err := integrity.ListFindings(ctx, rhinoq.FindingQuery{Limit: 100})
	if err != nil {
		t.Fatal(err)
	}
	if len(findings) != 25 {
		t.Fatalf("expected 25 open findings, got %d", len(findings))
	}

	// Nothing in the queue was touched. This is the whole promise of the
	// integrity plane: verification without adopting the runtime.
	var jobs int
	if err := testDB.QueryRow(`SELECT count(*) FROM rhinoq_jobs`).Scan(&jobs); err != nil {
		t.Fatal(err)
	}
	if jobs != 0 {
		t.Fatalf("an integrity-only scan must create no jobs, found %d", jobs)
	}

	// Scanning again with the data repaired resolves the Findings rather than
	// opening new ones.
	if _, err := testDB.Exec(`UPDATE rhinoq_rule_test_orders SET status = 'pending'`); err != nil {
		t.Fatal(err)
	}
	repaired, err := integrity.Scan(ctx, rhinoq.ScanRequest{RuleID: definition.ID})
	if err != nil {
		t.Fatal(err)
	}
	if repaired.Violated != 0 || repaired.Passed != 50 {
		t.Fatalf("a repaired fixture must pass: %+v", repaired)
	}
	open, err := integrity.ListFindings(ctx, rhinoq.FindingQuery{
		Statuses: []string{rhinoq.FindingOpen}, Limit: 100,
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(open) != 0 {
		t.Fatalf("passing rechecks must resolve their findings, %d still open", len(open))
	}
}

// A page budget must bound the run and hand back a usable cursor.
func TestScanStopsOnItsPageBudgetAndResumes(t *testing.T) {
	if testDB == nil {
		t.Skip("set RHINOQ_TEST_DATABASE_URL to run the PostgreSQL harness")
	}
	truncate(t)
	createRuleFixture(t)

	integrity, err := rhinoq.NewIntegrity(testDB)
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	definition := rhinoq.RuleDefinition{
		ID: "bounded-order-scan", Name: "Bounded order scan",
		Scope: rhinoq.RuleScopeTable, SubjectType: "order",
		Query: `SELECT id::text AS subject_id,
			status = 'paid' AS violated,
			jsonb_build_object('status', status) AS evidence
			FROM rhinoq_rule_test_orders
			WHERE created_at >= $1 AND id::text > $2
			ORDER BY id::text LIMIT $3`,
		BaselineAt: time.Date(2026, 7, 28, 0, 0, 0, 0, time.UTC),
		Every:      10 * time.Minute,
		MaxRows:    10,
	}
	if _, err := integrity.RegisterRule(ctx, definition); err != nil {
		t.Fatal(err)
	}
	if _, _, err := integrity.EnableRule(ctx, definition.ID); err != nil {
		t.Fatal(err)
	}

	first, err := integrity.Scan(ctx, rhinoq.ScanRequest{RuleID: definition.ID, MaxPages: 2})
	if err != nil {
		t.Fatal(err)
	}
	if first.Pages != 2 || !first.HasMore || first.NextCursor == "" {
		t.Fatalf("a two page budget must stop and hand back a cursor: %+v", first)
	}
	if first.Observed != 20 {
		t.Fatalf("two pages of ten must observe twenty subjects: %+v", first)
	}

	rest, err := integrity.Scan(ctx, rhinoq.ScanRequest{
		RuleID: definition.ID, Cursor: first.NextCursor,
	})
	if err != nil {
		t.Fatal(err)
	}
	if rest.HasMore {
		t.Fatalf("resuming must finish the remaining subjects: %+v", rest)
	}
	if total := first.Observed + rest.Observed; total != 50 {
		t.Fatalf("the two runs together must cover every subject exactly once, got %d", total)
	}
}

// A check that cannot conclude must not be recorded as a pass. This is the
// specific failure a boolean forced: a provider timeout looked identical to
// "this subject is fine", so real drift was silently resolved.
func TestUnknownObservationDoesNotResolveAnOpenFinding(t *testing.T) {
	if testDB == nil {
		t.Skip("set RHINOQ_TEST_DATABASE_URL to run the PostgreSQL harness")
	}
	truncate(t)
	createRuleFixture(t)

	integrity, err := rhinoq.NewIntegrity(testDB)
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()

	// First version: every paid order violates, opening Findings.
	violating := rhinoq.RuleDefinition{
		ID: "three-state-order", Name: "Three state order",
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
	if _, err := integrity.RegisterRule(ctx, violating); err != nil {
		t.Fatal(err)
	}
	if _, _, err := integrity.EnableRule(ctx, violating.ID); err != nil {
		t.Fatal(err)
	}
	opened, err := integrity.Scan(ctx, rhinoq.ScanRequest{RuleID: violating.ID})
	if err != nil {
		t.Fatal(err)
	}
	if opened.Violated != 25 {
		t.Fatalf("the fixture must open 25 findings first: %+v", opened)
	}

	// Second version of the same Rule: the check can no longer reach whatever
	// it needs, so it returns NULL with a reason instead of guessing.
	inconclusive := violating
	inconclusive.Query = `SELECT id::text AS subject_id,
		NULL::boolean AS violated,
		jsonb_build_object('status', status) AS evidence,
		'provider_timeout'::text AS unknown_reason
		FROM rhinoq_rule_test_orders
		WHERE created_at >= $1 AND id::text > $2
		ORDER BY id::text LIMIT $3`
	if _, err := integrity.RegisterRule(ctx, inconclusive); err != nil {
		t.Fatalf("a four column query must be accepted: %v", err)
	}
	if _, explanation, err := integrity.EnableRule(ctx, inconclusive.ID); err != nil {
		t.Fatalf("unknown_reason must pass the explain gate: %+v %v", explanation, err)
	}

	unknown, err := integrity.Scan(ctx, rhinoq.ScanRequest{RuleID: inconclusive.ID})
	if err != nil {
		t.Fatal(err)
	}
	if unknown.Unknown != 50 || unknown.Passed != 0 || unknown.Violated != 0 {
		t.Fatalf("every row must be reported as unknown, not passed: %+v", unknown)
	}

	// The Findings opened by the previous version must still be open. Under the
	// default retry policy an unknown opens nothing and resolves nothing.
	open, err := integrity.ListFindings(ctx, rhinoq.FindingQuery{
		Statuses: []string{rhinoq.FindingOpen}, Limit: 100,
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(open) != 25 {
		t.Fatalf("an unreachable provider must not close real drift: %d findings still open", len(open))
	}
	if unknown.Findings != 0 {
		t.Fatalf("the default policy opens nothing on unknown: %+v", unknown)
	}
}

// With the opposite policy, not knowing is itself the problem and opens a
// Finding that records why the check could not conclude.
func TestUnknownOpensAFindingWhenThePolicySaysSo(t *testing.T) {
	if testDB == nil {
		t.Skip("set RHINOQ_TEST_DATABASE_URL to run the PostgreSQL harness")
	}
	truncate(t)
	createRuleFixture(t)

	integrity, err := rhinoq.NewIntegrity(testDB)
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	definition := rhinoq.RuleDefinition{
		ID: "unknown-is-drift", Name: "Unknown is drift",
		Scope: rhinoq.RuleScopeTable, SubjectType: "order",
		Query: `SELECT id::text AS subject_id,
			NULL::boolean AS violated,
			jsonb_build_object('status', status) AS evidence,
			'permission_denied'::text AS unknown_reason
			FROM rhinoq_rule_test_orders
			WHERE created_at >= $1 AND id::text > $2
			ORDER BY id::text LIMIT $3`,
		BaselineAt: time.Date(2026, 7, 28, 0, 0, 0, 0, time.UTC),
		Every:      10 * time.Minute,
		OnUnknown:  rhinoq.UnknownOpensFinding,
	}
	if _, err := integrity.RegisterRule(ctx, definition); err != nil {
		t.Fatal(err)
	}
	if _, _, err := integrity.EnableRule(ctx, definition.ID); err != nil {
		t.Fatal(err)
	}
	summary, err := integrity.Scan(ctx, rhinoq.ScanRequest{RuleID: definition.ID})
	if err != nil {
		t.Fatal(err)
	}
	if summary.Unknown != 50 || summary.Findings != 50 {
		t.Fatalf("the finding policy must open one per unknown subject: %+v", summary)
	}
	findings, err := integrity.ListFindings(ctx, rhinoq.FindingQuery{Limit: 100})
	if err != nil {
		t.Fatal(err)
	}
	if len(findings) != 50 {
		t.Fatalf("expected 50 findings, got %d", len(findings))
	}
	if !strings.Contains(findings[0].LatestEvidence, "permission_denied") {
		t.Fatalf("a finding opened by an unknown must record why: %s", findings[0].LatestEvidence)
	}
	if !strings.Contains(findings[0].LatestEvidence, string(rhinoq.ObservationUnknown)) {
		t.Fatalf("an operator must be able to tell 'could not look' from 'looked and it was wrong': %s",
			findings[0].LatestEvidence)
	}
}
