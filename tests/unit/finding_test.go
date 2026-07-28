package unit_test

import (
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/madebyduy/RhinoQ/internal/domain/finding"
)

func TestFindingObservationDeduplicatesAndRegresses(t *testing.T) {
	firstSeen := time.Date(2026, 7, 27, 10, 0, 0, 0, time.UTC)
	observation := finding.Observation{
		Key: finding.Key{
			RuleID:                   "outcome-mismatch",
			SubjectType:              "job",
			SubjectID:                "job-1",
			ObservedInvariantVersion: 2,
		},
		Evidence:   `{"expected":"settled","actual":"pending"}`,
		ObservedAt: firstSeen,
	}

	record, err := finding.Apply(finding.Record{}, false, observation)
	if err != nil {
		t.Fatal(err)
	}
	if record.Status != finding.Open || record.OccurrenceCount != 1 {
		t.Fatalf("first observation must create one open finding: %+v", record)
	}

	record, err = finding.Apply(record, true, finding.Observation{
		Key:        observation.Key,
		Evidence:   `{"expected":"settled","actual":"failed"}`,
		ObservedAt: firstSeen.Add(time.Minute),
	})
	if err != nil {
		t.Fatal(err)
	}
	if record.OccurrenceCount != 2 || record.LatestEvidence == observation.Evidence {
		t.Fatalf("repeat observations must update the existing finding: %+v", record)
	}

	record, err = finding.ApplyTransition(record, finding.Transition{
		Status: finding.Resolved,
		Actor:  "ops@example.com",
		Reason: "business state repaired",
		At:     firstSeen.Add(2 * time.Minute),
	})
	if err != nil {
		t.Fatal(err)
	}
	record, err = finding.Apply(record, true, finding.Observation{
		Key:        observation.Key,
		Evidence:   observation.Evidence,
		ObservedAt: firstSeen.Add(3 * time.Minute),
	})
	if err != nil {
		t.Fatal(err)
	}
	if record.Status != finding.Regressed || !record.ResolvedAt.IsZero() {
		t.Fatalf("a resolved drift that returns must be marked regressed: %+v", record)
	}
}

func TestFindingEvidenceAndIdentityAreBounded(t *testing.T) {
	observation := finding.Observation{
		Key: finding.Key{
			RuleID: "rule", SubjectType: "report", SubjectID: "report-1",
			ObservedInvariantVersion: 1,
		},
		Evidence:   strings.Repeat("x", finding.MaxEvidenceBytes+1),
		ObservedAt: time.Now().UTC(),
	}
	if !errors.Is(observation.Validate(), finding.ErrEvidenceTooLarge) {
		t.Fatal("oversized evidence must be rejected before it reaches storage")
	}
	observation.Evidence = ""
	observation.SubjectID = strings.Repeat("x", finding.MaxSubjectIDBytes+1)
	if !errors.Is(observation.Validate(), finding.ErrInvalidKey) {
		t.Fatal("oversized business identity must be rejected")
	}
}

func TestFindingSuppressionRequiresReasonAndExpiry(t *testing.T) {
	now := time.Date(2026, 7, 27, 10, 0, 0, 0, time.UTC)
	record := finding.Record{Status: finding.Open}

	_, err := finding.ApplyTransition(record, finding.Transition{
		Status: finding.FalsePositive, Actor: "ops@example.com", Reason: "known provider lag", At: now,
	})
	if !errors.Is(err, finding.ErrExpiryRequired) {
		t.Fatalf("permanent suppression must be refused, got %v", err)
	}
	_, err = finding.ApplyTransition(record, finding.Transition{
		Status: finding.Ignored, Actor: "ops@example.com", Until: now.Add(time.Hour), At: now,
	})
	if !errors.Is(err, finding.ErrReasonRequired) {
		t.Fatalf("suppression without a reason must be refused, got %v", err)
	}

	suppressed, err := finding.ApplyTransition(record, finding.Transition{
		Status: finding.Ignored, Actor: "ops@example.com", Reason: "maintenance window",
		Until: now.Add(time.Hour), At: now,
	})
	if err != nil {
		t.Fatal(err)
	}
	if !suppressed.Suppressed(now.Add(30 * time.Minute)) {
		t.Fatal("an active suppression must be hidden from the daily view")
	}

	reopened, err := finding.Apply(suppressed, true, finding.Observation{
		Key: finding.Key{
			RuleID: "rule", SubjectType: "job", SubjectID: "job-1",
			ObservedInvariantVersion: 1,
		},
		ObservedAt: now.Add(2 * time.Hour),
	})
	if err != nil {
		t.Fatal(err)
	}
	if reopened.Status != finding.Open || !reopened.SuppressedUntil.IsZero() {
		t.Fatalf("an expired suppression must reopen when drift remains: %+v", reopened)
	}
}

func TestFindingTransitionRejectsInvalidOperatorActions(t *testing.T) {
	now := time.Date(2026, 7, 27, 10, 0, 0, 0, time.UTC)
	record := finding.Record{Status: finding.Open}

	_, err := finding.ApplyTransition(record, finding.Transition{
		Status: finding.Regressed, Actor: "ops@example.com", At: now,
	})
	if !errors.Is(err, finding.ErrInvalidTransition) {
		t.Fatalf("operators must not declare regression, got %v", err)
	}
	_, err = finding.ApplyTransition(record, finding.Transition{
		Status: finding.Acknowledged, At: now,
	})
	if !errors.Is(err, finding.ErrActorRequired) {
		t.Fatalf("operator transitions must identify an actor, got %v", err)
	}
}

func TestFindingPassResolvesExistingDriftWithoutCreatingHealthyNoise(t *testing.T) {
	now := time.Date(2026, 7, 28, 12, 0, 0, 0, time.UTC)
	key := finding.Key{
		RuleID: "report-output-exists", SubjectType: "report",
		SubjectID: "report-1", ObservedInvariantVersion: 1,
	}
	if _, changed, err := finding.ApplyPass(
		finding.Record{}, false, key, now,
	); err != nil || changed {
		t.Fatalf("healthy subject without a finding must be a no-op: changed=%v err=%v", changed, err)
	}
	open := finding.Record{
		Key: key, Status: finding.Open, FirstSeen: now.Add(-time.Minute),
		LastSeen: now.Add(-time.Minute), OccurrenceCount: 1,
	}
	resolved, changed, err := finding.ApplyPass(open, true, key, now)
	if err != nil || !changed || resolved.Status != finding.Resolved ||
		resolved.Actor != "rhinoq:rule" {
		t.Fatalf("a passing recheck must auto-resolve: %+v changed=%v err=%v", resolved, changed, err)
	}
}
