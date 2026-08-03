package contract

import (
	"encoding/json"
	"testing"
	"time"

	notificationcontract "github.com/madebyduy/RhinoQ/internal/contracts/notification"
)

// The notification message is the only RhinoQ payload that leaves the system
// entirely: a receiver somebody else wrote parses it and verifies an HMAC over
// its bytes. Now that the Node SDK can send one too, two implementations
// produce a payload that one receiver has to accept.
//
// A field renamed on one side does not fail anywhere at runtime — it arrives as
// undefined in a webhook handler nobody is watching. This is the binding.
func TestNotificationMessageMatchesGoldenV1(t *testing.T) {
	t.Parallel()
	observedAt := time.Date(2026, 8, 3, 15, 30, 0, 0, time.UTC)
	message := notificationcontract.Message{
		ID:               "finding_9f2c1d4b7a6e0358",
		Type:             "rhinoq.finding.updated",
		RuleID:           "completed-report-has-output",
		SubjectType:      "report",
		SubjectID:        "report-4471",
		InvariantVersion: 2,
		Status:           "regressed",
		Severity:         "high",
		Escalation:       true,
		Link:             "https://ops.example.com/findings/completed-report-has-output/report/report-4471",
		OccurrenceCount:  7,
		Evidence:         `{"status":"completed","hasOutput":false}`,
		ObservedAt:       observedAt,
	}

	actual, err := json.MarshalIndent(message, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	assertGolden(t, "notification-message-v1.json", append(actual, '\n'))
}

// Link and evidence are omitempty: a destination configured without
// --include-evidence must not receive an `evidence` key holding "". A receiver
// that branches on presence would read that as evidence it does not have.
func TestNotificationMessageOmitsAbsentLinkAndEvidence(t *testing.T) {
	t.Parallel()
	encoded, err := json.Marshal(notificationcontract.Message{
		ID: "finding_1", Type: "rhinoq.finding.updated", Status: "open",
		ObservedAt: time.Date(2026, 8, 3, 15, 30, 0, 0, time.UTC),
	})
	if err != nil {
		t.Fatal(err)
	}
	var wire map[string]any
	if err := json.Unmarshal(encoded, &wire); err != nil {
		t.Fatal(err)
	}
	for _, field := range []string{"link", "evidence"} {
		if _, present := wire[field]; present {
			t.Fatalf("%q must be omitted when absent, not sent empty: %s", field, encoded)
		}
	}
	// Everything else is unconditional. A receiver may rely on these existing.
	for _, field := range []string{
		"id", "type", "ruleId", "subjectType", "subjectId", "invariantVersion",
		"status", "severity", "escalation", "occurrenceCount", "observedAt",
	} {
		if _, present := wire[field]; !present {
			t.Fatalf("%q must always be present: %s", field, encoded)
		}
	}
}
