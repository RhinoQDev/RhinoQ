package task

import (
	"errors"
	"fmt"
	"strings"
	"time"
)

var (
	ErrInvalidRecord      = errors.New("invalid task record")
	ErrInvalidProgress    = errors.New("invalid task progress")
	ErrProgressRegression = errors.New("task progress cannot move backwards")
	ErrProgressTotal      = errors.New("task progress total cannot change once known")
	ErrInvalidResult      = errors.New("invalid task result reference")
	ErrProgressState      = errors.New("task does not accept progress in its current state")
)

type ID string

func (id ID) String() string { return string(id) }

// Progress deliberately supports both known-total and indeterminate work.
// The delivery layer can project this into a percentage without forcing every
// worker to invent a total.
type Progress struct {
	Completed int64
	Total     int64
	HasTotal  bool
	Message   string
}

// ExecutionCounts is maintained in the same transaction as Execution writes.
// It keeps TaskSummary bounded without rescanning a high fan-out history.
type ExecutionCounts struct {
	Total           int64
	PendingDispatch int64
	Dispatched      int64
	Running         int64
	Succeeded       int64
	Failed          int64
	Stalled         int64
	Cancelled       int64
}

func (c ExecutionCounts) Valid() bool {
	values := []int64{c.Total, c.PendingDispatch, c.Dispatched, c.Running,
		c.Succeeded, c.Failed, c.Stalled, c.Cancelled}
	var states int64
	for index, value := range values {
		if value < 0 {
			return false
		}
		if index > 0 {
			states += value
		}
	}
	return states == c.Total
}

func (p Progress) Valid() bool {
	if p.Completed < 0 || p.Total < 0 {
		return false
	}
	return !p.HasTotal || p.Total >= p.Completed
}

type Record struct {
	ID                 ID
	Type               string
	OwnerID            string
	DefinitionVersion  int
	State              State
	Progress           Progress
	ExecutionCounts    ExecutionCounts
	ResultRef          string
	CancellationStatus CancellationStatus
	CancellationReason string
	Version            int64
	CreatedAt          time.Time
	UpdatedAt          time.Time
}

type Spec struct {
	ID                ID
	Type              string
	OwnerID           string
	DefinitionVersion int
	Now               time.Time
}

func NewRecord(spec Spec) (Record, error) {
	if spec.ID == "" || strings.TrimSpace(spec.Type) == "" ||
		spec.DefinitionVersion <= 0 || spec.Now.IsZero() {
		return Record{}, ErrInvalidRecord
	}
	return Record{
		ID:                 spec.ID,
		Type:               strings.TrimSpace(spec.Type),
		OwnerID:            strings.TrimSpace(spec.OwnerID),
		DefinitionVersion:  spec.DefinitionVersion,
		State:              Pending,
		CancellationStatus: CancellationNone,
		Version:            1,
		CreatedAt:          spec.Now,
		UpdatedAt:          spec.Now,
	}, nil
}

func (r Record) Transition(to State, now time.Time) (Record, error) {
	if err := r.valid(now); err != nil {
		return r, err
	}
	next, err := Transition(r.State, to)
	if err != nil {
		return r, err
	}
	previous := r.State
	r.State = next
	switch {
	case next == Queued && (previous == Failed || previous == Cancelled):
		r.CancellationStatus = CancellationNone
		r.CancellationReason = ""
	case next == CancelRequested && r.CancellationStatus == CancellationNone:
		r.CancellationStatus = CancellationRequested
	case previous == CancelRequested && next == Cancelled:
		r.CancellationStatus = CancellationCancelled
	case previous == CancelRequested && next == Succeeded:
		r.CancellationStatus = CancellationTooLate
	case previous == CancelRequested && next == Failed:
		r.CancellationStatus = CancellationFailed
	}
	r.Version++
	r.UpdatedAt = now
	return r, nil
}

func (r Record) ApplyProgress(progress Progress, now time.Time) (Record, error) {
	if err := r.valid(now); err != nil {
		return r, err
	}
	if !progress.Valid() {
		return r, ErrInvalidProgress
	}
	if !r.acceptsProgress() {
		return r, ErrProgressState
	}
	if progress.Completed < r.Progress.Completed {
		return r, ErrProgressRegression
	}
	if r.Progress.HasTotal {
		if !progress.HasTotal || progress.Total != r.Progress.Total {
			return r, ErrProgressTotal
		}
	}
	// A re-delivered event carrying the value already stored changes nothing.
	// Advancing the version for it would push an identical snapshot to every
	// watcher and fail concurrent writers that still hold the previous version.
	if progress == r.Progress {
		return r, nil
	}
	r.Progress = progress
	r.Version++
	r.UpdatedAt = now
	return r, nil
}

// ProgressIsCurrent reports whether ApplyProgress would leave this record
// unchanged. A write that cannot lose an update does not need a version fence,
// so callers use this to answer a duplicate without touching the store.
func (r Record) ProgressIsCurrent(progress Progress) bool {
	return r.acceptsProgress() && progress.Valid() && progress == r.Progress
}

func (r Record) acceptsProgress() bool {
	return r.State == Running || r.State == CancelRequested
}

func (r Record) AttachResult(resultRef string, now time.Time) (Record, error) {
	if err := r.valid(now); err != nil {
		return r, err
	}
	if strings.TrimSpace(resultRef) == "" {
		return r, ErrInvalidResult
	}
	r.ResultRef = strings.TrimSpace(resultRef)
	r.Version++
	r.UpdatedAt = now
	return r, nil
}

func (r Record) valid(now time.Time) error {
	if r.ID == "" || strings.TrimSpace(r.Type) == "" ||
		r.DefinitionVersion <= 0 || !r.State.Valid() || r.Version <= 0 ||
		r.CreatedAt.IsZero() || r.UpdatedAt.IsZero() || now.IsZero() {
		return fmt.Errorf("%w: malformed record", ErrInvalidRecord)
	}
	if !r.CancellationStatus.Valid() {
		return fmt.Errorf("%w: malformed cancellation", ErrInvalidRecord)
	}
	if !r.Progress.Valid() {
		return fmt.Errorf("%w: malformed progress", ErrInvalidRecord)
	}
	if !r.ExecutionCounts.Valid() {
		return fmt.Errorf("%w: malformed execution counts", ErrInvalidRecord)
	}
	return nil
}
