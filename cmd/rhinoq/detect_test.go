package main

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/madebyduy/RhinoQ/pkg/rhinoq"
)

const validQuery = `SELECT id::text AS subject_id,
	output_key IS NULL AS violated,
	jsonb_build_object('status', status) AS evidence
FROM public.reports
WHERE updated_at >= $1
  AND (($4::text = '' AND id::text > $2) OR id::text = $4)
ORDER BY id::text
LIMIT $3`

func writeRuleFile(t *testing.T, body string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "rules.json")
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

// The starter file is what a new adopter edits first, so it has to survive the
// same loader as a hand-written one.
func TestDetectExampleFileLoads(t *testing.T) {
	rules, err := loadDetectRules(writeRuleFile(t, detectExample))
	if err != nil {
		t.Fatalf("the built-in example does not load: %v", err)
	}
	if len(rules) != 1 || rules[0].ID != "completed-report-has-output" {
		t.Fatalf("unexpected example rules: %+v", rules)
	}
}

// `rhinoq detect --example > rules.json` in PowerShell writes a BOM. The
// command must accept the file it just produced.
func TestDetectRuleFileToleratesByteOrderMark(t *testing.T) {
	// Written as an escape: Go only allows a literal BOM at the start of a file.
	path := writeRuleFile(t, "\ufeff"+detectExample)
	if _, err := loadDetectRules(path); err != nil {
		t.Fatalf("BOM-prefixed file rejected: %v", err)
	}
}

func TestDetectRuleFileRejectsBadInput(t *testing.T) {
	cases := map[string]struct{ body, wants string }{
		"no rules": {
			body: `{"rules":[]}`, wants: "declares no rules",
		},
		"duplicate id": {
			body: `{"rules":[
				{"id":"a","subjectType":"report","query":"` + oneLine(validQuery) + `"},
				{"id":"a","subjectType":"report","query":"` + oneLine(validQuery) + `"}
			]}`,
			wants: "duplicate Rule id",
		},
		"missing subject type": {
			body:  `{"rules":[{"id":"a","query":"` + oneLine(validQuery) + `"}]}`,
			wants: "needs a subjectType",
		},
		"unknown field": {
			body: `{"rules":[{"id":"a","subjectType":"report","scope":"job",` +
				`"query":"` + oneLine(validQuery) + `"}]}`,
			wants: "unknown field",
		},
		"page size above the store limit": {
			body: `{"rules":[{"id":"a","subjectType":"report","maxRows":100000,` +
				`"query":"` + oneLine(validQuery) + `"}]}`,
			wants: "maxRows must be between",
		},
		"query cannot page": {
			body: `{"rules":[{"id":"a","subjectType":"report",` +
				`"query":"SELECT id AS subject_id, false AS violated, '{}' AS evidence FROM r WHERE u >= $1"}]}`,
			wants: "must page",
		},
		"statement timeout above the store limit": {
			body: `{"rules":[{"id":"a","subjectType":"report","statementTimeout":"10m",` +
				`"query":"` + oneLine(validQuery) + `"}]}`,
			wants: "statementTimeout must be",
		},
	}
	for name, testCase := range cases {
		t.Run(name, func(t *testing.T) {
			_, err := loadDetectRules(writeRuleFile(t, testCase.body))
			if err == nil || !strings.Contains(err.Error(), testCase.wants) {
				t.Fatalf("expected an error containing %q, got %v", testCase.wants, err)
			}
		})
	}
}

// A detector Rule is always table-scoped. Job scope reads RhinoQ's own runtime
// tables, and the detector has none.
func TestDetectRuleIsAlwaysTableScoped(t *testing.T) {
	definition, err := detectRule{
		ID: "a", SubjectType: "report", Query: validQuery,
	}.toDefinition()
	if err != nil {
		t.Fatal(err)
	}
	if definition.Scope != rhinoq.RuleScopeTable {
		t.Fatalf("scope = %q, want %q", definition.Scope, rhinoq.RuleScopeTable)
	}
}

// The defaults a file omits must match the defaults the store applies, or every
// pass looks like a changed Rule and registers a new version.
func TestDetectRuleDefaultsMatchTheStore(t *testing.T) {
	definition, err := detectRule{
		ID: "a", SubjectType: "report", Query: validQuery,
	}.toDefinition()
	if err != nil {
		t.Fatal(err)
	}
	if definition.Cursor != rhinoq.CursorSubject ||
		definition.OnUnknown != rhinoq.UnknownRetries {
		t.Fatalf("unexpected defaults: cursor=%q onUnknown=%q",
			definition.Cursor, definition.OnUnknown)
	}
	if !sameRuleShape(definition, definition) {
		t.Fatal("a definition must match itself")
	}
	// BaselineAt moves every call; it must not count as a shape change.
	time.Sleep(time.Millisecond)
	later, err := detectRule{
		ID: "a", SubjectType: "report", Query: validQuery,
	}.toDefinition()
	if err != nil {
		t.Fatal(err)
	}
	if later.BaselineAt.Equal(definition.BaselineAt) {
		t.Skip("clock did not advance; the comparison below proves nothing")
	}
	if !sameRuleShape(definition, later) {
		t.Fatal("a moving baseline must not be treated as a changed Rule")
	}
}

func TestSameRuleShapeIgnoresFormattingButNotMeaning(t *testing.T) {
	base, err := detectRule{
		ID: "a", SubjectType: "report", Query: validQuery,
	}.toDefinition()
	if err != nil {
		t.Fatal(err)
	}
	reformatted := base
	reformatted.Query = oneLine(validQuery)
	if !sameRuleShape(base, reformatted) {
		t.Fatal("whitespace must not count as a changed Rule")
	}
	narrowed := base
	narrowed.MaxRows = base.MaxRows - 1
	if sameRuleShape(base, narrowed) {
		t.Fatal("a changed page size must count as a changed Rule")
	}
}

func TestDetectRequiresARuleFile(t *testing.T) {
	var output bytes.Buffer
	code := runDetect(nil, func(string) string { return "" }, &output)
	if code != 2 || !strings.Contains(output.String(), "--rules is required") {
		t.Fatalf("code=%d output=%s", code, output.String())
	}
	if !strings.Contains(output.String(), "--example") {
		t.Fatal("the error should name the command that produces a Rule file")
	}
}

func TestDetectPrintsTheExampleWithoutADatabase(t *testing.T) {
	var output bytes.Buffer
	code := runDetect([]string{"--example"}, func(string) string {
		t.Fatal("--example must not read the environment")
		return ""
	}, &output)
	if code != 0 || !strings.Contains(output.String(), `"rules"`) {
		t.Fatalf("code=%d output=%s", code, output.String())
	}
}

// Without a subject database there is nothing to read, and the message has to
// name the variable rather than fail generically.
func TestDetectWithoutAnyDatabaseNamesTheVariable(t *testing.T) {
	var output bytes.Buffer
	code := runDetect(
		[]string{"--rules", writeRuleFile(t, detectExample)},
		func(string) string { return "" },
		&output,
	)
	if code != 1 ||
		!strings.Contains(output.String(), "RHINOQ_SUBJECT_DATABASE_URL") {
		t.Fatalf("code=%d output=%s", code, output.String())
	}
}

// --store without a store URL must not silently fall back to writing into the
// application's database.
func TestDetectStoreWithoutStoreURLRefuses(t *testing.T) {
	var output bytes.Buffer
	code := runDetect(
		[]string{"--rules", writeRuleFile(t, detectExample), "--store"},
		func(key string) string {
			if key == "RHINOQ_SUBJECT_DATABASE_URL" {
				// Unreachable on purpose: the flag check must fail first.
				return "postgres://user:pass@127.0.0.1:1/none?sslmode=disable"
			}
			return ""
		},
		&output,
	)
	if code != 1 {
		t.Fatalf("code=%d output=%s", code, output.String())
	}
}

func TestDetectRejectsANonPositiveWatchInterval(t *testing.T) {
	var output bytes.Buffer
	code := runDetect(
		[]string{"--rules", writeRuleFile(t, detectExample), "--watch", "0s"},
		func(string) string { return "" },
		&output,
	)
	if code != 2 || !strings.Contains(output.String(), "--watch") {
		t.Fatalf("code=%d output=%s", code, output.String())
	}
}

func TestPrintDetectReportSeparatesUnknownFromPassed(t *testing.T) {
	var output bytes.Buffer
	printDetectReport(&output, []detectRuleResult{{
		RuleID: "r", Observed: 4, Passed: 2, Violated: 1, Unknown: 1,
	}}, nil)
	text := output.String()
	if !strings.Contains(text, "UNKNOWN") {
		t.Fatalf("unknown must have its own column:\n%s", text)
	}
	if !strings.Contains(oneLine(text), "r 4 2 1 1") {
		t.Fatalf("unexpected counts:\n%s", text)
	}
	if !strings.Contains(text, "No open Findings.") {
		t.Fatalf("a clean pass must say so:\n%s", text)
	}
}

func TestPrintDetectReportShowsExplainReasons(t *testing.T) {
	var output bytes.Buffer
	printDetectReport(&output, []detectRuleResult{{
		RuleID: "r", Error: "rule explain exceeded its query safety budget",
		Reasons: []string{"plan cost 91000 exceeds 50000"},
	}}, nil)
	text := output.String()
	if !strings.Contains(text, "FAIL r") ||
		!strings.Contains(text, "plan cost 91000 exceeds 50000") {
		t.Fatalf("a rejected Rule must print why:\n%s", text)
	}
}

func oneLine(query string) string {
	return strings.Join(strings.Fields(query), " ")
}
