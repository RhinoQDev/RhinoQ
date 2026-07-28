package integration

import (
	"context"
	"net/http"
	"testing"
	"time"

	"github.com/madebyduy/RhinoQ/pkg/rhinoq"
)

func TestPersistentFindingLifecycleDeduplicatesAndKeepsHistory(t *testing.T) {
	client := rhinoq.NewInMemory()
	ctx := context.Background()
	key := rhinoq.FindingKey{
		RuleID: "report-output-exists", SubjectType: "report",
		SubjectID: "report-42", InvariantVersion: 1,
	}
	first := time.Date(2026, 7, 28, 9, 0, 0, 0, time.UTC)

	record, err := client.ObserveFinding(ctx, rhinoq.FindingObservation{
		FindingKey: key, Evidence: `{"outputObject":null}`, ObservedAt: first,
	})
	if err != nil {
		t.Fatal(err)
	}
	if record.Status != rhinoq.FindingOpen || record.OccurrenceCount != 1 {
		t.Fatalf("first observation must open one finding: %+v", record)
	}
	record, err = client.ObserveFinding(ctx, rhinoq.FindingObservation{
		FindingKey: key, Evidence: `{"outputObject":"missing"}`,
		ObservedAt: first.Add(time.Minute),
	})
	if err != nil {
		t.Fatal(err)
	}
	if record.OccurrenceCount != 2 || record.LatestEvidence != `{"outputObject":"missing"}` {
		t.Fatalf("repeat observation must fold into the same finding: %+v", record)
	}

	record, err = client.TransitionFinding(ctx, key, rhinoq.FindingTransition{
		Status: rhinoq.FindingAcknowledged, Actor: "ops@example.com",
		At: first.Add(2 * time.Minute),
	})
	if err != nil {
		t.Fatal(err)
	}
	if record.Status != rhinoq.FindingAcknowledged {
		t.Fatalf("finding should be acknowledged: %+v", record)
	}

	records, err := client.ListFindings(ctx, rhinoq.FindingQuery{
		SubjectType: "report", SubjectID: "report-42", Limit: 50,
	})
	if err != nil || len(records) != 1 {
		t.Fatalf("finding must be queryable by business subject: len=%d err=%v", len(records), err)
	}
	history, err := client.FindingHistory(ctx, key, 0, 50)
	if err != nil {
		t.Fatal(err)
	}
	if len(history) != 3 || history[0].Kind != "transitioned" ||
		history[1].Kind != "observed" || history[2].Kind != "observed" {
		t.Fatalf("expected newest-first append-only history: %+v", history)
	}
}

func TestAgentExposesFindingObservationAndOperatorTransition(t *testing.T) {
	server := newAgentServer(t)
	key := map[string]any{
		"ruleId": "account-must-provision", "subjectType": "account",
		"subjectId": "acct-9", "invariantVersion": 1,
	}

	var observed struct {
		Finding rhinoq.FindingRecord `json:"finding"`
	}
	call(t, server, http.MethodPost, "/v1/findings/observe", map[string]any{
		"ruleId": "account-must-provision", "subjectType": "account",
		"subjectId": "acct-9", "invariantVersion": 1,
		"evidence": `{"provisioned":false}`,
	}, http.StatusOK, &observed)
	if observed.Finding.Status != rhinoq.FindingOpen {
		t.Fatalf("Agent must persist an open finding: %+v", observed.Finding)
	}

	call(t, server, http.MethodPost, "/v1/findings/transition", map[string]any{
		"key": key,
		"transition": map[string]any{
			"status": rhinoq.FindingResolved,
			"actor":  "ops@example.com", "reason": "account provisioned manually",
		},
	}, http.StatusOK, nil)

	var listed struct {
		Findings []rhinoq.FindingRecord `json:"findings"`
	}
	call(t, server, http.MethodGet,
		"/v1/findings?subjectType=account&subjectId=acct-9&limit=10",
		nil, http.StatusOK, &listed)
	if len(listed.Findings) != 1 || listed.Findings[0].Status != rhinoq.FindingResolved {
		t.Fatalf("Agent must expose the persisted lifecycle: %+v", listed.Findings)
	}
}
