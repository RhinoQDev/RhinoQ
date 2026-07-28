package integration

import (
	"context"
	"testing"
	"time"

	"github.com/madebyduy/RhinoQ/pkg/rhinoq"
)

func TestNeedsAttentionIncludesPersistentIntegrityFindings(t *testing.T) {
	client := rhinoq.NewInMemory()
	_, err := client.ObserveFinding(context.Background(), rhinoq.FindingObservation{
		FindingKey: rhinoq.FindingKey{
			RuleID: "report-output-exists", SubjectType: "report",
			SubjectID: "report-42", InvariantVersion: 3,
		},
		Evidence:   `{"outputKey":null}`,
		ObservedAt: time.Date(2026, 7, 28, 10, 0, 0, 0, time.UTC),
	})
	if err != nil {
		t.Fatal(err)
	}
	items, err := client.ListAttention(context.Background(), "", 0, 20)
	if err != nil {
		t.Fatal(err)
	}
	if len(items) != 1 || items[0].Kind != rhinoq.AttentionIntegrityFinding ||
		items[0].ReferenceID != "report-output-exists/report/report-42@v3" {
		t.Fatalf("integrity finding must appear in the unified inbox: %+v", items)
	}
	filtered, err := client.ListAttention(context.Background(), "reports", 0, 20)
	if err != nil {
		t.Fatal(err)
	}
	if len(filtered) != 0 {
		t.Fatalf("queue filter must not guess a finding-to-queue mapping: %+v", filtered)
	}
}

func TestNeedsAttentionExcludesResolvedAndSuppressedFindings(t *testing.T) {
	client := rhinoq.NewInMemory()
	now := time.Now().UTC()
	for index, status := range []string{
		rhinoq.FindingResolved,
		rhinoq.FindingIgnored,
	} {
		key := rhinoq.FindingKey{
			RuleID: "report-output-exists", SubjectType: "report",
			SubjectID: "hidden-" + status, InvariantVersion: index + 1,
		}
		if _, err := client.ObserveFinding(context.Background(), rhinoq.FindingObservation{
			FindingKey: key, ObservedAt: now,
		}); err != nil {
			t.Fatal(err)
		}
		transition := rhinoq.FindingTransition{
			Status: status, Actor: "operator@example.com",
			Reason: "reviewed", At: now.Add(time.Second),
		}
		if status == rhinoq.FindingIgnored {
			transition.Until = now.Add(time.Hour)
		}
		if _, err := client.TransitionFinding(
			context.Background(), key, transition,
		); err != nil {
			t.Fatal(err)
		}
	}
	items, err := client.ListAttention(context.Background(), "", 0, 20)
	if err != nil {
		t.Fatal(err)
	}
	if len(items) != 0 {
		t.Fatalf("resolved and actively suppressed Findings must be hidden: %+v", items)
	}
}
