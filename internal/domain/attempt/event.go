// Package attempt defines the immutable execution timeline of a job.
//
// A job row is hot state and is intentionally updated in place. Attempt events
// are evidence: every lease reservation and terminal decision is appended so
// operators can reconstruct what happened without trusting the current row.
package attempt

import (
	"errors"
	"time"

	"github.com/rhinoq/rhinoq/internal/domain/job"
)

// Kind describes one fact in an execution lifecycle.
type Kind string

const (
	Claimed        Kind = "claimed"
	Succeeded      Kind = "succeeded"
	RetryScheduled Kind = "retry_scheduled"
	Dead           Kind = "dead"
	Blocked        Kind = "blocked"
	Cancelled      Kind = "cancelled"
	Released       Kind = "released"
	LeaseExpired   Kind = "lease_expired"
)

func (k Kind) Valid() bool {
	switch k {
	case Claimed, Succeeded, RetryScheduled, Dead, Blocked, Cancelled, Released, LeaseExpired:
		return true
	default:
		return false
	}
}

// Event is append-only evidence for one lease epoch. Sequence is assigned by
// the store and provides a stable ordering even when timestamps are equal.
type Event struct {
	Sequence      int64
	JobID         job.ID
	Attempt       int
	LeaseOwner    string
	LeaseEpoch    int64
	Kind          Kind
	ResultState   job.State
	FailureClass  string
	BlockedReason job.BlockedReason
	OccurredAt    time.Time
}

func (e Event) Validate() error {
	if e.JobID == "" || e.Attempt <= 0 || e.LeaseOwner == "" || e.LeaseEpoch <= 0 ||
		!e.Kind.Valid() || e.OccurredAt.IsZero() {
		return errors.New("attempt event requires a job, positive attempt and epoch, owner, kind and occurrence time")
	}
	if e.ResultState != "" && !e.ResultState.Valid() {
		return errors.New("attempt event has an invalid result state")
	}
	return nil
}

// ResultKind maps a terminal job transition to its timeline event.
func ResultKind(state job.State) (Kind, error) {
	switch state {
	case job.RetryWait:
		return RetryScheduled, nil
	case job.Dead:
		return Dead, nil
	case job.Blocked:
		return Blocked, nil
	case job.Cancelled:
		return Cancelled, nil
	default:
		return "", errors.New("job state has no failed-attempt event")
	}
}
