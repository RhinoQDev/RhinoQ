package unit

import (
	"testing"
	"time"

	"github.com/madebyduy/RhinoQ/internal/domain/outcome"
)

func TestOutcomeApplyPreservesBusinessMeaning(t *testing.T) {
	now := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	record, err := outcome.NewRecord("outcome_1", "job_1", outcome.Contract{Version: 1}, now)
	if err != nil {
		t.Fatal(err)
	}

	cases := []struct {
		name  string
		state outcome.State
	}{
		{name: "achieved", state: outcome.Achieved},
		{name: "mismatch", state: outcome.Mismatch},
		{name: "unverifiable", state: outcome.Unverifiable},
		{name: "stale", state: outcome.Stale},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			updated, err := record.Apply(outcome.Observation{State: tc.state, Reason: tc.name}, now)
			if err != nil {
				t.Fatal(err)
			}
			if updated.State != tc.state || updated.Reason != tc.name {
				t.Fatalf("unexpected outcome: %+v", updated)
			}
		})
	}
}
