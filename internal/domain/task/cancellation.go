package task

import (
	"errors"
	"strings"
	"time"
)

var (
	ErrInvalidCancellation = errors.New("invalid task cancellation transition")
)

// CancellationStatus is deliberately separate from Task State. A Task may
// succeed while a cancellation request has the outcome TooLate.
type CancellationStatus string

const (
	CancellationNone         CancellationStatus = "none"
	CancellationRequested    CancellationStatus = "requested"
	CancellationAcknowledged CancellationStatus = "acknowledged"
	CancellationCancelled    CancellationStatus = "cancelled"
	CancellationTooLate      CancellationStatus = "too_late"
	CancellationCannotCancel CancellationStatus = "cannot_cancel_safely"
	CancellationFailed       CancellationStatus = "failed"
)

func (s CancellationStatus) Valid() bool {
	switch s {
	case CancellationNone, CancellationRequested, CancellationAcknowledged,
		CancellationCancelled, CancellationTooLate, CancellationCannotCancel,
		CancellationFailed:
		return true
	default:
		return false
	}
}

// RequestCancellation records the user's intent to stop the Task. Repeating it
// on a Task that already carries the request is a no-op: the intent is stored
// once, so a retried click must not consume an entity version.
func (r Record) RequestCancellation(now time.Time) (Record, error) {
	if err := r.valid(now); err != nil {
		return r, err
	}
	if r.CancellationIsRequested() {
		return r, nil
	}
	return r.Transition(CancelRequested, now)
}

// CancellationIsRequested reports whether RequestCancellation would leave this
// record unchanged.
func (r Record) CancellationIsRequested() bool { return r.State == CancelRequested }

func (r Record) ResolveCancellation(
	status CancellationStatus,
	reason string,
	now time.Time,
) (Record, error) {
	if err := r.valid(now); err != nil {
		return r, err
	}
	if r.State != CancelRequested ||
		(r.CancellationStatus != CancellationRequested &&
			r.CancellationStatus != CancellationAcknowledged) {
		return r, ErrInvalidCancellation
	}
	switch status {
	case CancellationAcknowledged, CancellationCannotCancel, CancellationFailed:
	default:
		return r, ErrInvalidCancellation
	}
	r.CancellationStatus = status
	r.CancellationReason = strings.TrimSpace(reason)
	r.Version++
	r.UpdatedAt = now
	return r, nil
}
