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
