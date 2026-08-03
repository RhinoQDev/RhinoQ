package contract

import (
	"encoding/json"
	"testing"
	"time"

	"github.com/madebyduy/RhinoQ/pkg/rhinoq"
)

// The Node CLI's verify tests answer POST /v1/rules from
// testdata/contracts/rule-record-v1.json. Until now nothing checked that the
// Go Gateway actually produces that shape, so the fixture was free to drift
// into a contract only the mock believed in — the CLI would keep passing while
// the real Gateway sent something else.
//
// RuleRecord also carries a hand-written MarshalJSON, because durations must
// leave Go as milliseconds. Letting encoding/json marshal a time.Duration would
// emit nanoseconds and make every client schedule its Rule 1,000,000 times too
// slowly, with no error anywhere. That conversion is exactly the kind of thing
// a golden file is for.
func TestRuleRecordMatchesGoldenV1(t *testing.T) {
	t.Parallel()
	registeredAt := time.Date(2026, 8, 3, 2, 54, 57, 46*int(time.Millisecond), time.UTC)
	record := rhinoq.RuleRecord{
		RuleDefinition: rhinoq.RuleDefinition{
			ID:          "completed-report-has-output",
			Name:        "Completed Report Has Output",
			Scope:       rhinoq.RuleScopeTable,
			SubjectType: "report",
			Query: "SELECT id::text AS subject_id, output_url IS NULL AS violated,\n" +
				"       jsonb_build_object('status', status, 'hasOutput', output_url IS NOT NULL) AS evidence\n" +
				"FROM completed_reports\n" +
				"WHERE created_at >= $1\n" +
				"  AND id::text > $2\n" +
				"ORDER BY id\n" +
				"LIMIT $3\n",
			BaselineAt:       registeredAt,
			Every:            5 * time.Minute,
			Within:           0,
			Cursor:           "subject",
			OnUnknown:        "retry",
			UnknownGrace:     0,
			MaxRows:          500,
			StatementTimeout: 5 * time.Second,
			MaxPlanCost:      100_000,
			MaxSeqScanRows:   10_000,
		},
		Version:   1,
		Status:    rhinoq.RuleDraft,
		CreatedAt: registeredAt,
		UpdatedAt: registeredAt,
	}

	actual, err := json.MarshalIndent(record, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	assertGolden(t, "rule-record-v1.json", append(actual, '\n'))
}

// A duration that reaches the wire in nanoseconds is silent: the JSON parses,
// the field is a number, and the Rule simply never runs when the operator
// expects. Pin the unit itself rather than only the golden bytes.
func TestRuleRecordSendsDurationsInMilliseconds(t *testing.T) {
	t.Parallel()
	record := rhinoq.RuleRecord{
		RuleDefinition: rhinoq.RuleDefinition{
			Every:            90 * time.Second,
			Within:           2 * time.Minute,
			UnknownGrace:     30 * time.Second,
			StatementTimeout: 1500 * time.Millisecond,
		},
	}

	encoded, err := json.Marshal(record)
	if err != nil {
		t.Fatal(err)
	}
	var wire map[string]any
	if err := json.Unmarshal(encoded, &wire); err != nil {
		t.Fatal(err)
	}

	for field, want := range map[string]float64{
		"everyMs":            90_000,
		"withinMs":           120_000,
		"unknownGraceMs":     30_000,
		"statementTimeoutMs": 1_500,
	} {
		got, ok := wire[field].(float64)
		if !ok {
			t.Fatalf("%s is missing from the Rule wire contract", field)
		}
		if got != want {
			t.Fatalf("%s = %v, want %v milliseconds; a nanosecond value here schedules the Rule 1,000,000x too slowly", field, got, want)
		}
	}
}
