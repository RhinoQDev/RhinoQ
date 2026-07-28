package integration

import (
	"context"
	"net/http"
	"testing"
	"time"

	"github.com/madebyduy/RhinoQ/pkg/rhinoq"
)

func TestRuleDefinitionsAreVersionedAndStartAsDraft(t *testing.T) {
	client := rhinoq.NewInMemory()
	definition := rhinoq.RuleDefinition{
		ID: "report-output-exists", Name: "Report output exists",
		Scope: rhinoq.RuleScopeJob, SubjectType: "report", JobName: "generate-report",
		Query: `SELECT id::text AS subject_id, output_key IS NULL AS violated,
			'{}'::jsonb AS evidence
			FROM reports WHERE id::text = $1 AND output_key IS NULL`,
	}
	first, err := client.RegisterRule(context.Background(), definition)
	if err != nil {
		t.Fatal(err)
	}
	second, err := client.RegisterRule(context.Background(), definition)
	if err != nil {
		t.Fatal(err)
	}
	if first.Version != 1 || second.Version != 2 ||
		first.Status != rhinoq.RuleDraft || second.Status != rhinoq.RuleDraft {
		t.Fatalf("rule versions must be append-only drafts: first=%+v second=%+v", first, second)
	}
	records, err := client.ListRules(context.Background(), rhinoq.RuleQuery{Limit: 20})
	if err != nil || len(records) != 1 || records[0].Version != 2 {
		t.Fatalf("list must show the latest version: records=%+v err=%v", records, err)
	}
}

func TestAgentRegistersAndListsTableRules(t *testing.T) {
	server := newAgentServer(t)
	var created struct {
		Rule rhinoq.RuleRecord `json:"rule"`
	}
	call(t, server, http.MethodPost, "/v1/rules", map[string]any{
		"id": "order-must-provision", "name": "Order must provision",
		"scope": "table", "subjectType": "order",
		"query": `SELECT id::text AS subject_id, true AS violated,
			'{}'::jsonb AS evidence
			FROM orders WHERE created_at >= $1 AND id::text > $2
			ORDER BY id::text LIMIT $3`,
		"baselineAt": time.Date(2026, 7, 28, 0, 0, 0, 0, time.UTC),
		"everyMs":    600000,
	}, http.StatusCreated, &created)
	if created.Rule.Status != rhinoq.RuleDraft || created.Rule.Version != 1 {
		t.Fatalf("Agent must create a versioned draft: %+v", created.Rule)
	}
	var listed struct {
		Rules []rhinoq.RuleRecord `json:"rules"`
	}
	call(t, server, http.MethodGet, "/v1/rules?scope=table&limit=20",
		nil, http.StatusOK, &listed)
	if len(listed.Rules) != 1 || listed.Rules[0].ID != "order-must-provision" {
		t.Fatalf("Agent must list the registered rule: %+v", listed.Rules)
	}
}
