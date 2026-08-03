package main

import (
	"os"
	"path/filepath"

	"bytes"
	"github.com/madebyduy/RhinoQ/pkg/rhinoq"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestRunExplainCallsAuthenticatedAgent(t *testing.T) {
	var authorization string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		authorization = r.Header.Get("Authorization")
		if r.Method != http.MethodPost || r.URL.Path != "/v1/rules/report-output/explain" {
			t.Fatalf("unexpected request: %s %s", r.Method, r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"explanation":{"safe":true}}`))
	}))
	defer server.Close()
	var output bytes.Buffer
	code := runExplain([]string{"report-output"}, func(key string) string {
		switch key {
		case "RHINOQ_AGENT_URL":
			return server.URL
		case "RHINOQ_AGENT_TOKEN":
			return "secret"
		default:
			return ""
		}
	}, &output)
	if code != 0 || authorization != "Bearer secret" ||
		!strings.Contains(output.String(), `"safe":true`) {
		t.Fatalf("explain failed: code=%d auth=%q output=%s", code, authorization, output.String())
	}
}

func TestRunExplainFallsBackToEmbeddedPostgresWithoutGateway(t *testing.T) {
	var output bytes.Buffer
	if code := runExplain([]string{"rule"}, func(string) string { return "" }, &output); code == 0 {
		t.Fatal("explain must not pretend success without PostgreSQL")
	}
	if !strings.Contains(output.String(), "RHINOQ_DATABASE_URL") {
		t.Fatalf("failure should say how to fix configuration: %s", output.String())
	}
}

func TestWorkbenchRejectsInvalidPortBeforeStartingServer(t *testing.T) {
	var output bytes.Buffer
	code := runWorkbench(
		[]string{"--demo", "--port", "70000", "--no-open"},
		func(string) string { return "" },
		&output,
	)
	if code != 2 || !strings.Contains(output.String(), "--port must be between") {
		t.Fatalf("unexpected result: code=%d output=%s", code, output.String())
	}
}

func TestDatabaseSourceLabelNeverIncludesCredentials(t *testing.T) {
	label := databaseSourceLabel("postgres://secret-user:secret-pass@db.internal:5432/app?sslmode=require")
	if label != "db.internal/app" {
		t.Fatalf("unexpected safe source label %q", label)
	}
}

func TestInitIntegrityOnlyPlansNoWorker(t *testing.T) {
	var output bytes.Buffer
	if code := runInit([]string{"--integrity-only"}, &output); code != 0 {
		t.Fatalf("init returned %d: %s", code, output.String())
	}
	text := output.String()
	if !strings.Contains(text, "Rules, scans and Findings") ||
		!strings.Contains(text, "do not configure or start a queue worker") {
		t.Fatalf("integrity plan is unclear: %s", text)
	}
	if strings.Contains(text, "embedded worker, scheduler") {
		t.Fatalf("integrity-only plan leaked runtime setup: %s", text)
	}
}

func TestInitRejectsUnknownOption(t *testing.T) {
	var output bytes.Buffer
	if code := runInit([]string{"--surprise"}, &output); code != 2 {
		t.Fatalf("expected usage error, got %d: %s", code, output.String())
	}
}

func TestScanRejectsInvalidBoundsBeforeOpeningDatabase(t *testing.T) {
	var output bytes.Buffer
	code := runScan(
		[]string{"report-output", "--max-pages", "-1"},
		func(string) string { return "" },
		&output,
	)
	if code != 2 || !strings.Contains(output.String(), "--max-pages") {
		t.Fatalf("unexpected scan result: code=%d output=%s", code, output.String())
	}
}

func TestScanRejectsSubjectWithCursorBeforeOpeningDatabase(t *testing.T) {
	var output bytes.Buffer
	code := runScan(
		[]string{"report-output", "--subject", "report_1", "--cursor", "report_0"},
		func(string) string { return "" },
		&output,
	)
	if code != 2 || !strings.Contains(output.String(), "cannot be combined") {
		t.Fatalf("unexpected scan result: code=%d output=%s", code, output.String())
	}
}

func TestHelpDocumentsEveryPublicCommand(t *testing.T) {
	for _, topic := range []string{
		"help", "init", "migrate", "doctor", "jobs", "queue",
		"attention", "findings", "rules", "scan", "explain", "notify", "workbench",
		"ui", "version",
	} {
		t.Run(topic, func(t *testing.T) {
			var output bytes.Buffer
			if code := runHelp([]string{topic}, &output); code != 0 {
				t.Fatalf("help %s returned %d: %s", topic, code, output.String())
			}
			if !strings.Contains(output.String(), "Usage:") {
				t.Fatalf("help %s has no usage section: %s", topic, output.String())
			}
		})
	}
}

func TestHelpRejectsUnknownTopic(t *testing.T) {
	var output bytes.Buffer
	if code := runHelp([]string{"missing"}, &output); code != 2 {
		t.Fatalf("expected usage error, got %d: %s", code, output.String())
	}
	if !strings.Contains(output.String(), "unknown help topic") {
		t.Fatalf("help should explain the failure: %s", output.String())
	}
}

func TestRuleCreateRejectsAnUnsafeQueryBeforeOpeningDatabase(t *testing.T) {
	path := filepath.Join(t.TempDir(), "unsafe.sql")
	if err := os.WriteFile(path, []byte("DELETE FROM reports WHERE id = $1"), 0o600); err != nil {
		t.Fatal(err)
	}
	var output bytes.Buffer
	code := runRuleCreate(
		[]string{"probe", "--query-file", path, "--subject-type", "report"},
		func(string) string { return "" },
		&output,
	)
	if code != 1 || !strings.Contains(output.String(), "read-only SELECT") {
		t.Fatalf("a mutation must be refused locally: code=%d output=%s", code, output.String())
	}
}

func TestRuleCreateRequiresAQueryFileAndSubjectType(t *testing.T) {
	var output bytes.Buffer
	code := runRuleCreate([]string{"probe"}, func(string) string { return "" }, &output)
	if code != 2 || !strings.Contains(output.String(), "--query-file") {
		t.Fatalf("unexpected result: code=%d output=%s", code, output.String())
	}
}

// A re-apply appends a version, and a version bump cuts the link to every
// Finding recorded against the old one. The operator has to see what changed
// before that happens, so the diff is part of the contract, not decoration.
func TestRuleChangeDiffNamesTheChangedQueryLineAndBudget(t *testing.T) {
	existing := rhinoq.RuleRecord{
		RuleDefinition: rhinoq.RuleDefinition{
			ID: "probe", Name: "Probe", Scope: rhinoq.RuleScopeTable,
			SubjectType: "report", Query: "SELECT $1\nWHERE status = 'done'\nLIMIT $3",
			MaxRows: 500,
		},
		Version: 2,
	}
	proposed := existing.RuleDefinition
	proposed.Query = "SELECT $1\nWHERE status = 'completed'\nLIMIT $3"
	proposed.MaxRows = 100

	changes := describeRuleChanges(existing, proposed)
	joined := strings.Join(changes, "\n")
	if !strings.Contains(joined, "max rows: 500 -> 100") {
		t.Fatalf("a changed budget must be named: %s", joined)
	}
	if !strings.Contains(joined, "query line 2 - WHERE status = 'done'") ||
		!strings.Contains(joined, "query line 2 + WHERE status = 'completed'") {
		t.Fatalf("the changed predicate must be shown, not summarised: %s", joined)
	}
	if strings.Contains(joined, "query line 1") || strings.Contains(joined, "query line 3") {
		t.Fatalf("unchanged lines must stay out of the diff: %s", joined)
	}
}

func TestIdenticalRuleDefinitionProducesNoChanges(t *testing.T) {
	record := rhinoq.RuleRecord{
		RuleDefinition: rhinoq.RuleDefinition{
			ID: "probe", Name: "Probe", Scope: rhinoq.RuleScopeTable,
			SubjectType: "report", Query: "SELECT $1 LIMIT $3", MaxRows: 500,
		},
		Version: 1,
	}
	if changes := describeRuleChanges(record, record.RuleDefinition); len(changes) != 0 {
		t.Fatalf("an unchanged re-apply must not claim a diff: %v", changes)
	}
}

func TestRuleDeleteRequiresARuleID(t *testing.T) {
	var output bytes.Buffer
	code := runRuleDelete([]string{"--apply"}, func(string) string { return "" }, &output)
	if code != 2 || !strings.Contains(output.String(), "rules delete <rule-id>") {
		t.Fatalf("unexpected result: code=%d output=%s", code, output.String())
	}
}
