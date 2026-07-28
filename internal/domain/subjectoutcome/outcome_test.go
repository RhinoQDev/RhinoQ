package subjectoutcome

import (
	"testing"
	"time"

	"github.com/madebyduy/RhinoQ/internal/domain/rule"
)

func TestUnknownGraceTracksOneContinuousUnknownStreak(t *testing.T) {
	key := Key{
		RuleID: "report-ready", RuleVersion: 2,
		SubjectType: "report", SubjectID: "report-42",
	}
	started := time.Date(2026, 7, 28, 10, 0, 0, 0, time.UTC)
	first, err := Apply(Record{}, false, key, rule.Observation{
		SubjectID: key.SubjectID, Status: rule.Unknown,
		Reason: "provider_timeout",
	}, started)
	if err != nil {
		t.Fatal(err)
	}
	if first.UnknownEscalationDue(10*time.Minute, started.Add(9*time.Minute)) {
		t.Fatal("an unknown must stay observational during its grace period")
	}

	second, err := Apply(first, true, key, rule.Observation{
		SubjectID: key.SubjectID, Status: rule.Unknown,
		Reason: "provider_timeout",
	}, started.Add(10*time.Minute))
	if err != nil {
		t.Fatal(err)
	}
	if second.FirstUnknownAt != started || second.UnknownCount != 2 {
		t.Fatalf("a repeated unknown must preserve its streak: %+v", second)
	}
	if !second.UnknownEscalationDue(10*time.Minute, started.Add(10*time.Minute)) {
		t.Fatal("a continuous unknown must escalate when grace expires")
	}
}

func TestConclusionResetsUnknownGrace(t *testing.T) {
	key := Key{
		RuleID: "report-ready", RuleVersion: 1,
		SubjectType: "report", SubjectID: "report-42",
	}
	now := time.Date(2026, 7, 28, 10, 0, 0, 0, time.UTC)
	unknown, err := Apply(Record{}, false, key, rule.Observation{
		SubjectID: key.SubjectID, Status: rule.Unknown,
	}, now)
	if err != nil {
		t.Fatal(err)
	}
	passed, err := Apply(unknown, true, key, rule.Observation{
		SubjectID: key.SubjectID, Status: rule.Passed,
	}, now.Add(time.Minute))
	if err != nil {
		t.Fatal(err)
	}
	if !passed.FirstUnknownAt.IsZero() || passed.UnknownCount != 0 {
		t.Fatalf("a conclusion must end the unknown streak: %+v", passed)
	}
}
