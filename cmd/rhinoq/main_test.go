package main

import (
	"bytes"
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
		"attention", "findings", "rules", "scan", "explain", "workbench",
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
