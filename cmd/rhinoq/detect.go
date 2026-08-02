package main

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"sort"
	"strings"
	"text/tabwriter"
	"time"

	"github.com/madebyduy/RhinoQ/pkg/rhinoq"
)

// detect is the front door. It answers one question — "does any row in this
// database contradict a rule I declared?" — with one command, one read-only
// role and, by default, nothing written anywhere.
//
// Everything else RhinoQ can do (Tasks, ProviderOperation, guarded repair)
// requires a decision from someone who owns the application's database. This
// command deliberately requires none: a reviewer who can grant SELECT can
// approve the whole evaluation.

// detectRule is the on-disk shape of a Rule. It is deliberately narrower than
// rhinoq.RuleDefinition: a detector Rule is always table-scoped, because a
// job-scoped Rule reads RhinoQ's own runtime tables and the detector has none.
type detectRule struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	SubjectType string `json:"subjectType"`
	Query       string `json:"query"`
	// BaselineWithin is relative on purpose. An absolute timestamp in a file
	// that is committed once and run for months silently widens every scan.
	BaselineWithin   string `json:"baselineWithin,omitempty"`
	Every            string `json:"every,omitempty"`
	MaxRows          int    `json:"maxRows,omitempty"`
	StatementTimeout string `json:"statementTimeout,omitempty"`
	Cursor           string `json:"cursor,omitempty"`
	OnUnknown        string `json:"onUnknown,omitempty"`
	UnknownGrace     string `json:"unknownGrace,omitempty"`
}

type detectFile struct {
	Rules []detectRule `json:"rules"`
}

const detectExample = `{
  "rules": [
    {
      "id": "completed-report-has-output",
      "name": "Completed reports have an output object",
      "subjectType": "report",
      "baselineWithin": "24h",
      "every": "10m",
      "maxRows": 100,
      "statementTimeout": "3s",
      "query": "SELECT id::text AS subject_id, CASE WHEN status = 'completed' THEN output_key IS NULL ELSE false END AS violated, jsonb_build_object('status', status, 'outputKey', output_key) AS evidence FROM public.reports WHERE updated_at >= $1 AND (($4::text = '' AND id::text > $2) OR id::text = $4) ORDER BY id::text LIMIT $3"
    }
  ]
}
`

func runDetect(args []string, getenv func(string) string, output io.Writer) int {
	flags := flag.NewFlagSet("detect", flag.ContinueOnError)
	flags.SetOutput(output)
	rulesPath := flags.String("rules", "", "path to a JSON Rule file")
	example := flags.Bool("example", false, "print a starter Rule file and exit")
	store := flags.Bool("store", false,
		"persist Rules and Findings in RHINOQ_DATABASE_URL instead of memory")
	watch := flags.String("watch", "", "re-scan on this interval instead of exiting")
	asJSON := flags.Bool("json", false, "print machine-readable JSON")
	failOnFinding := flags.Bool("fail-on-finding", false,
		"exit 1 when any Rule is violated")
	maxPages := flags.Int("max-pages", 0, "page budget per Rule per pass")
	timeout := flags.Duration("timeout", 2*time.Minute, "wall-clock budget per pass")
	if err := flags.Parse(args); err != nil {
		return 2
	}
	if *example {
		_, _ = io.WriteString(output, detectExample)
		return 0
	}
	if strings.TrimSpace(*rulesPath) == "" {
		fmt.Fprintln(output, "FAIL --rules is required")
		fmt.Fprintln(output, "Usage: rhinoq detect --rules rules.json")
		fmt.Fprintln(output, "Start one: rhinoq detect --example > rules.json")
		return 2
	}
	definitions, err := loadDetectRules(*rulesPath)
	if err != nil {
		fmt.Fprintf(output, "FAIL read Rule file\n  %v\n", err)
		return 2
	}
	var watchEvery time.Duration
	if strings.TrimSpace(*watch) != "" {
		watchEvery, err = time.ParseDuration(*watch)
		if err != nil || watchEvery <= 0 {
			fmt.Fprintf(output, "FAIL --watch must be a positive duration such as 5m\n")
			return 2
		}
	}

	subjects, storeDB, closers, err := openDetectDatabases(*store, getenv)
	if err != nil {
		fmt.Fprintf(output, "FAIL database\n  %v\n", err)
		return 1
	}
	defer func() {
		for _, closer := range closers {
			_ = closer.Close()
		}
	}()
	if storeDB != nil {
		migrateCtx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
		if code := applyStoreMigrations(migrateCtx, storeDB, output); code != 0 {
			cancel()
			return code
		}
		cancel()
	}
	client, err := rhinoq.NewDetector(subjects, storeDB)
	if err != nil {
		fmt.Fprintf(output, "FAIL open detector\n  %v\n", err)
		return 1
	}

	for {
		code := detectPass(
			client, definitions, *maxPages, *timeout,
			*asJSON, *failOnFinding, output,
		)
		if watchEvery == 0 {
			return code
		}
		// A watch loop that exits on the first bad pass is a cron job with extra
		// steps. Report and keep looking.
		time.Sleep(watchEvery)
	}
}

// openDetectDatabases resolves the two-connection model. The subject database
// is the application's and is only ever read; the store database is RhinoQ's
// own and is the only one that is migrated.
func openDetectDatabases(
	persist bool,
	getenv func(string) string,
) (subjects, store *sql.DB, closers []io.Closer, err error) {
	subjectURL := strings.TrimSpace(getenv("RHINOQ_SUBJECT_DATABASE_URL"))
	storeURL := strings.TrimSpace(getenv("RHINOQ_DATABASE_URL"))
	if subjectURL == "" && storeURL == "" {
		return nil, nil, nil, errors.New(
			"set RHINOQ_SUBJECT_DATABASE_URL to the application database RhinoQ should read")
	}
	defer func() {
		if err != nil {
			for _, closer := range closers {
				_ = closer.Close()
			}
			closers = nil
		}
	}()
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	if subjectURL == "" {
		// Single-database shape: the caller pointed only at RHINOQ_DATABASE_URL,
		// so RhinoQ reads and writes the same place. Legal, but not the detector
		// the docs recommend.
		subjectURL = storeURL
	}
	subjects, err = openDatabaseURL(ctx, subjectURL, getenv)
	if err != nil {
		return nil, nil, nil, fmt.Errorf("connect to the subject database: %w", err)
	}
	closers = append(closers, subjects)
	if !persist {
		return subjects, nil, closers, nil
	}
	if storeURL == "" {
		return nil, nil, closers, errors.New(
			"--store needs RHINOQ_DATABASE_URL: a database RhinoQ may write to, separate from the application's")
	}
	if storeURL == subjectURL {
		// Sharing one URL means RhinoQ's tables land in the application's
		// database, which is exactly the migration cost the detector exists to
		// avoid. Say so instead of silently doing it.
		store = subjects
		return subjects, store, closers, nil
	}
	store, err = openDatabaseURL(ctx, storeURL, getenv)
	if err != nil {
		return nil, nil, closers, fmt.Errorf("connect to the RhinoQ store database: %w", err)
	}
	closers = append(closers, store)
	return subjects, store, closers, nil
}

func detectPass(
	client *rhinoq.IntegrityClient,
	definitions []detectRule,
	maxPages int,
	timeout time.Duration,
	asJSON, failOnFinding bool,
	output io.Writer,
) int {
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()

	results := make([]detectRuleResult, 0, len(definitions))
	findings := make([]rhinoq.FindingRecord, 0)
	failures := 0
	violations := 0

	for _, definition := range definitions {
		result := detectRuleResult{RuleID: definition.ID}
		if err := ensureDetectRule(ctx, client, definition); err != nil {
			result.Error = err.Error()
			var unsafe *ruleGateError
			if errors.As(err, &unsafe) {
				result.Reasons = unsafe.reasons
			}
			failures++
			results = append(results, result)
			continue
		}
		summary, err := client.Scan(ctx, rhinoq.ScanRequest{
			RuleID: definition.ID, MaxPages: maxPages,
		})
		result.Observed = summary.Observed
		result.Passed = summary.Passed
		result.Violated = summary.Violated
		result.Unknown = summary.Unknown
		if err != nil {
			result.Error = err.Error()
			failures++
		}
		violations += summary.Violated
		results = append(results, result)

		found, err := client.ListFindings(ctx, rhinoq.FindingQuery{
			RuleID: definition.ID,
			Statuses: []string{
				rhinoq.FindingOpen, rhinoq.FindingRegressed,
				rhinoq.FindingAcknowledged,
			},
			Limit: 100,
		})
		if err != nil {
			failures++
			continue
		}
		findings = append(findings, found...)
	}
	sort.SliceStable(findings, func(i, j int) bool {
		if findings[i].RuleID != findings[j].RuleID {
			return findings[i].RuleID < findings[j].RuleID
		}
		return findings[i].SubjectID < findings[j].SubjectID
	})

	if asJSON {
		_ = printJSON(output, map[string]any{
			"rules": results, "findings": findings,
			"scannedAt": time.Now().UTC(),
		})
	} else {
		printDetectReport(output, results, findings)
	}
	if failures > 0 {
		return 1
	}
	if failOnFinding && violations > 0 {
		return 1
	}
	return 0
}

// detectRuleResult is one Rule's outcome for one pass. Passed, Violated and
// Unknown partition Observed; Unknown is reported separately because folding a
// check that could not conclude into "passed" is exactly how drift hides.
type detectRuleResult struct {
	RuleID   string   `json:"ruleId"`
	Observed int      `json:"observed"`
	Passed   int      `json:"passed"`
	Violated int      `json:"violated"`
	Unknown  int      `json:"unknown"`
	Error    string   `json:"error,omitempty"`
	Reasons  []string `json:"reasons,omitempty"`
}

func printDetectReport(
	output io.Writer,
	results []detectRuleResult,
	findings []rhinoq.FindingRecord,
) {
	table := tabwriter.NewWriter(output, 0, 0, 2, ' ', 0)
	fmt.Fprintln(table, "RULE\tOBSERVED\tPASSED\tVIOLATED\tUNKNOWN")
	for _, result := range results {
		if result.Error != "" {
			fmt.Fprintf(table, "%s\t-\t-\t-\t-\n", result.RuleID)
			continue
		}
		fmt.Fprintf(table, "%s\t%d\t%d\t%d\t%d\n",
			result.RuleID, result.Observed, result.Passed,
			result.Violated, result.Unknown)
	}
	_ = table.Flush()

	for _, result := range results {
		if result.Error == "" {
			continue
		}
		fmt.Fprintf(output, "\nFAIL %s\n  %s\n", result.RuleID, result.Error)
		for _, reason := range result.Reasons {
			fmt.Fprintf(output, "  - %s\n", reason)
		}
	}
	if len(findings) == 0 {
		fmt.Fprintln(output, "\nNo open Findings.")
		return
	}
	fmt.Fprintf(output, "\n%d open Finding(s)\n", len(findings))
	for _, item := range findings {
		fmt.Fprintf(output, "  %s %s/%s  seen=%d  since=%s\n",
			item.Status, item.SubjectType, item.SubjectID,
			item.OccurrenceCount, item.FirstSeen.UTC().Format(time.RFC3339))
		if evidence := strings.TrimSpace(item.LatestEvidence); evidence != "" {
			fmt.Fprintf(output, "    evidence %s\n", evidence)
		}
	}
	fmt.Fprintln(output,
		"\nA Finding states that something is wrong. RhinoQ does not repair the row.")
}

func ensureDetectRule(
	ctx context.Context,
	client *rhinoq.IntegrityClient,
	definition detectRule,
) error {
	wanted, err := definition.toDefinition()
	if err != nil {
		return err
	}
	existing, err := client.ListRules(ctx, rhinoq.RuleQuery{
		Statuses: []string{
			rhinoq.RuleEnabled, rhinoq.RuleDraft, rhinoq.RuleDisabled,
		},
		Limit: 1000,
	})
	if err != nil {
		return err
	}
	// Registering appends a new immutable version, and a Finding is keyed to the
	// version that opened it. Re-registering an unchanged Rule on every pass
	// would therefore orphan yesterday's Findings and reopen each one as new,
	// which reads as churn rather than as drift.
	for _, record := range existing {
		if record.ID != wanted.ID || !sameRuleShape(record.RuleDefinition, wanted) {
			continue
		}
		if record.Status == rhinoq.RuleEnabled {
			return nil
		}
		if _, explanation, err := client.EnableRule(ctx, record.ID); err != nil {
			return &ruleGateError{ruleID: record.ID, cause: err, reasons: explanation.Reasons}
		}
		return nil
	}
	registered, err := client.RegisterRule(ctx, wanted)
	if err != nil {
		return err
	}
	if _, explanation, err := client.EnableRule(ctx, registered.ID); err != nil {
		return &ruleGateError{ruleID: registered.ID, cause: err, reasons: explanation.Reasons}
	}
	return nil
}

// ruleGateError carries the Explain reasons alongside the failure, because
// "rule is unsafe" without the plan cost is not actionable.
type ruleGateError struct {
	ruleID  string
	cause   error
	reasons []string
}

func (e *ruleGateError) Error() string {
	if len(e.reasons) == 0 {
		return e.cause.Error()
	}
	return e.cause.Error() + ": " + strings.Join(e.reasons, "; ")
}

func (e *ruleGateError) Unwrap() error { return e.cause }

func sameRuleShape(current, wanted rhinoq.RuleDefinition) bool {
	return normalizeSQL(current.Query) == normalizeSQL(wanted.Query) &&
		current.SubjectType == wanted.SubjectType &&
		current.MaxRows == wanted.MaxRows &&
		current.Every == wanted.Every &&
		current.StatementTimeout == wanted.StatementTimeout &&
		current.Cursor == wanted.Cursor &&
		current.OnUnknown == wanted.OnUnknown
}

func normalizeSQL(query string) string {
	return strings.Join(strings.Fields(query), " ")
}

func (r detectRule) toDefinition() (rhinoq.RuleDefinition, error) {
	definition := rhinoq.RuleDefinition{
		ID: strings.TrimSpace(r.ID), Name: strings.TrimSpace(r.Name),
		Scope:       rhinoq.RuleScopeTable,
		SubjectType: strings.TrimSpace(r.SubjectType),
		Query:       r.Query,
		MaxRows:     r.MaxRows,
		Cursor:      strings.TrimSpace(r.Cursor),
		OnUnknown:   strings.TrimSpace(r.OnUnknown),
	}
	// Fill the same defaults the store applies on save. Leaving them empty here
	// makes a stored Rule look different from the file that produced it, which
	// is what would trigger the pointless re-registration above.
	if definition.Cursor == "" {
		definition.Cursor = rhinoq.CursorSubject
	}
	if definition.OnUnknown == "" {
		definition.OnUnknown = rhinoq.UnknownRetries
	}
	if definition.ID == "" {
		return definition, errors.New("every Rule needs an id")
	}
	if definition.Name == "" {
		definition.Name = definition.ID
	}
	if definition.SubjectType == "" {
		return definition, fmt.Errorf("Rule %q needs a subjectType", definition.ID)
	}
	if strings.TrimSpace(definition.Query) == "" {
		return definition, fmt.Errorf("Rule %q needs a query", definition.ID)
	}
	if definition.MaxRows == 0 {
		definition.MaxRows = 100
	}
	// The store rejects these bounds with an error that does not name them, so
	// the file that set them is where the complaint belongs.
	if definition.MaxRows < 0 || definition.MaxRows > rhinoq.MaxRuleRows {
		return definition, fmt.Errorf(
			"Rule %q maxRows must be between 1 and %d: a Rule pages, it does not scan a table in one statement",
			definition.ID, rhinoq.MaxRuleRows)
	}
	if !strings.Contains(r.Query, "$2") || !strings.Contains(r.Query, "$3") {
		return definition, fmt.Errorf(
			"Rule %q query must page: use $2 as the subject cursor and $3 as the page size",
			definition.ID)
	}
	baselineWithin, err := optionalDuration(r.BaselineWithin, 24*time.Hour)
	if err != nil {
		return definition, fmt.Errorf("Rule %q baselineWithin: %w", definition.ID, err)
	}
	definition.BaselineAt = time.Now().UTC().Add(-baselineWithin)
	if definition.Every, err = optionalDuration(r.Every, 10*time.Minute); err != nil {
		return definition, fmt.Errorf("Rule %q every: %w", definition.ID, err)
	}
	if definition.StatementTimeout, err = optionalDuration(
		r.StatementTimeout, 3*time.Second,
	); err != nil {
		return definition, fmt.Errorf("Rule %q statementTimeout: %w", definition.ID, err)
	}
	if definition.StatementTimeout <= 0 ||
		definition.StatementTimeout > rhinoq.MaxRuleStatementTimeout {
		return definition, fmt.Errorf(
			"Rule %q statementTimeout must be above zero and at most %s",
			definition.ID, rhinoq.MaxRuleStatementTimeout)
	}
	if definition.UnknownGrace, err = optionalDuration(r.UnknownGrace, 0); err != nil {
		return definition, fmt.Errorf("Rule %q unknownGrace: %w", definition.ID, err)
	}
	return definition, nil
}

func optionalDuration(value string, fallback time.Duration) (time.Duration, error) {
	if strings.TrimSpace(value) == "" {
		return fallback, nil
	}
	parsed, err := time.ParseDuration(value)
	if err != nil {
		return 0, err
	}
	if parsed < 0 {
		return 0, errors.New("must not be negative")
	}
	return parsed, nil
}

func loadDetectRules(path string) ([]detectRule, error) {
	body, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	// `rhinoq detect --example > rules.json` in PowerShell writes a UTF-8 BOM,
	// and the decoder would reject the file this command just produced.
	body = bytes.TrimPrefix(body, []byte{0xEF, 0xBB, 0xBF})
	var file detectFile
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&file); err != nil {
		return nil, err
	}
	if len(file.Rules) == 0 {
		return nil, errors.New("the Rule file declares no rules")
	}
	seen := make(map[string]bool, len(file.Rules))
	for _, definition := range file.Rules {
		id := strings.TrimSpace(definition.ID)
		if seen[id] {
			return nil, fmt.Errorf("duplicate Rule id %q", id)
		}
		seen[id] = true
		if _, err := definition.toDefinition(); err != nil {
			return nil, err
		}
	}
	return file.Rules, nil
}
