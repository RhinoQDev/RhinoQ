package unit

import (
	"testing"
	"time"

	"github.com/madebyduy/RhinoQ/internal/domain/attempt"
	"github.com/madebyduy/RhinoQ/internal/domain/job"
)

// Attempt events are the evidence an operator reads when the job row and the
// story disagree. Validate() and Kind.Valid() had no test, which means the one
// guard standing between a malformed event and the append-only timeline was
// itself unverified.

func TestOnlyKnownAttemptKindsAreValid(t *testing.T) {
	t.Parallel()
	known := []attempt.Kind{
		attempt.Claimed, attempt.Succeeded, attempt.RetryScheduled, attempt.Dead,
		attempt.Blocked, attempt.Cancelled, attempt.Released, attempt.LeaseExpired,
	}
	for _, kind := range known {
		if !kind.Valid() {
			t.Fatalf("%q is part of the timeline vocabulary and must be valid", kind)
		}
	}
	for _, kind := range []attempt.Kind{"", "failed", "Claimed", "succeeded "} {
		if kind.Valid() {
			t.Fatalf("%q must not be accepted; an unknown kind reaching the timeline is unreadable evidence", kind)
		}
	}
}

func TestAttemptEventRequiresACompleteExecutionIdentity(t *testing.T) {
	t.Parallel()
	now := time.Date(2026, 8, 3, 13, 0, 0, 0, time.UTC)
	valid := attempt.Event{
		Sequence: 1, JobID: "job-1", Attempt: 1, LeaseOwner: "worker-1",
		LeaseEpoch: 1, Kind: attempt.Claimed, OccurredAt: now,
	}
	if err := valid.Validate(); err != nil {
		t.Fatalf("a complete claim event must validate: %v", err)
	}

	cases := map[string]func(attempt.Event) attempt.Event{
		"no job":           func(e attempt.Event) attempt.Event { e.JobID = ""; return e },
		"zero attempt":     func(e attempt.Event) attempt.Event { e.Attempt = 0; return e },
		"negative attempt": func(e attempt.Event) attempt.Event { e.Attempt = -1; return e },
		"no lease owner":   func(e attempt.Event) attempt.Event { e.LeaseOwner = ""; return e },
		"zero lease epoch": func(e attempt.Event) attempt.Event { e.LeaseEpoch = 0; return e },
		"unknown kind":     func(e attempt.Event) attempt.Event { e.Kind = "whatever"; return e },
		"no occurrence":    func(e attempt.Event) attempt.Event { e.OccurredAt = time.Time{}; return e },
		"bad result state": func(e attempt.Event) attempt.Event { e.ResultState = job.State("done"); return e },
	}
	for name, mutate := range cases {
		mutate := mutate
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			if err := mutate(valid).Validate(); err == nil {
				t.Fatalf("%s must be refused", name)
			}
		})
	}
}

// The epoch is what distinguishes one execution's evidence from the next. An
// event without it cannot be attributed, so it is not evidence at all.
func TestAttemptEventAcceptsAnEmptyResultStateOnly(t *testing.T) {
	t.Parallel()
	now := time.Date(2026, 8, 3, 13, 0, 0, 0, time.UTC)
	event := attempt.Event{
		JobID: "job-1", Attempt: 2, LeaseOwner: "worker-1", LeaseEpoch: 2,
		Kind: attempt.RetryScheduled, ResultState: job.RetryWait, OccurredAt: now,
	}
	if err := event.Validate(); err != nil {
		t.Fatalf("a valid terminal result state must be accepted: %v", err)
	}
	event.ResultState = ""
	if err := event.Validate(); err != nil {
		t.Fatalf("an event that records no result state must still validate: %v", err)
	}
}

func TestResultKindMapsOnlyFailedTransitions(t *testing.T) {
	t.Parallel()
	for state, want := range map[job.State]attempt.Kind{
		job.RetryWait: attempt.RetryScheduled,
		job.Dead:      attempt.Dead,
		job.Blocked:   attempt.Blocked,
		job.Cancelled: attempt.Cancelled,
	} {
		got, err := attempt.ResultKind(state)
		if err != nil {
			t.Fatalf("%s must map to a timeline event: %v", state, err)
		}
		if got != want {
			t.Fatalf("%s mapped to %q, want %q", state, got, want)
		}
	}

	// Succeeded, pending and leased are not failed-attempt outcomes. Mapping
	// them here would let a success be appended through the failure path and
	// read as a failure in the timeline.
	for _, state := range []job.State{job.Succeeded, job.Pending, job.Leased, ""} {
		if _, err := attempt.ResultKind(state); err == nil {
			t.Fatalf("%q must not map to a failed-attempt event", state)
		}
	}
}
