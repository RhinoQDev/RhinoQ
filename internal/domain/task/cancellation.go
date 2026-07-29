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
