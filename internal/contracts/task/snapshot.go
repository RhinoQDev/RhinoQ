// Package task defines the versioned read contract for user-facing Task state.
// It contains transport-neutral data only; mapping from domain records belongs
// to the application layer.
package task

import (
	"errors"
	"time"
)

const (
	SnapshotSchemaVersion = 1
	ResultSchemaVersion   = 1
)

var (
	ErrInvalidSnapshot = errors.New("invalid task snapshot")
	ErrInvalidResult   = errors.New("invalid task result")
)

type Progress struct {
	Completed int64  `json:"completed"`
	Total     *int64 `json:"total,omitempty"`
	Message   string `json:"message,omitempty"`
}

// Execution carries per-attempt outcome but never the storage reference
// itself: polling must not repeatedly ship a location that may be sensitive.
// Read the references through ExecutionResults instead.
type Execution struct {
	ID            string `json:"id"`
	Attempt       int    `json:"attempt"`
	Runtime       string `json:"runtime"`
	State         string `json:"state"`
	Version       int64  `json:"version"`
	HasResult     bool   `json:"hasResult"`
	FailureReason string `json:"failureReason,omitempty"`
}

type Cancellation struct {
	Status string `json:"status"`
	Reason string `json:"reason,omitempty"`
}

type Snapshot struct {
	SchemaVersion int          `json:"schemaVersion"`
	EntityVersion int64        `json:"entityVersion"`
	ID            string       `json:"id"`
	Type          string       `json:"type"`
	OwnerID       string       `json:"ownerId,omitempty"`
	State         string       `json:"state"`
	Cancellation  Cancellation `json:"cancellation"`
	Progress      Progress     `json:"progress"`
	HasResult     bool         `json:"hasResult"`
	Executions    []Execution  `json:"executions"`
	CreatedAt     time.Time    `json:"createdAt"`
	UpdatedAt     time.Time    `json:"updatedAt"`
}

// Result is separate from Snapshot so state polling does not repeatedly send
// a potentially sensitive storage reference.
type Result struct {
	SchemaVersion int       `json:"schemaVersion"`
	EntityVersion int64     `json:"entityVersion"`
	TaskID        string    `json:"taskId"`
	Reference     string    `json:"reference"`
	UpdatedAt     time.Time `json:"updatedAt"`
}

// ExecutionResult is one item's outcome in a fan-out: where its artifact
// landed, or why it failed. Without this an application has to keep its own
// per-item store, which is exactly the plumbing the Task layer exists to remove.
type ExecutionResult struct {
	ExecutionID   string    `json:"executionId"`
	Attempt       int       `json:"attempt"`
	State         string    `json:"state"`
	Reference     string    `json:"reference,omitempty"`
	FailureReason string    `json:"failureReason,omitempty"`
	UpdatedAt     time.Time `json:"updatedAt"`
}

// ExecutionResults is read separately from the Snapshot and carries the Task
// version it was read at, so a caller can tell whether it matches the snapshot
// currently on screen.
type ExecutionResults struct {
	SchemaVersion int               `json:"schemaVersion"`
	EntityVersion int64             `json:"entityVersion"`
	TaskID        string            `json:"taskId"`
	Executions    []ExecutionResult `json:"executions"`
}

func (r ExecutionResults) Validate() error {
	if r.SchemaVersion != ResultSchemaVersion || r.EntityVersion <= 0 || r.TaskID == "" {
		return ErrInvalidResult
	}
	for _, item := range r.Executions {
		if item.ExecutionID == "" || item.Attempt <= 0 || item.State == "" ||
			item.UpdatedAt.IsZero() {
			return ErrInvalidResult
		}
	}
	return nil
}

func (r Result) Validate() error {
	if r.SchemaVersion != ResultSchemaVersion || r.EntityVersion <= 0 ||
		r.TaskID == "" || r.Reference == "" || r.UpdatedAt.IsZero() {
		return ErrInvalidResult
	}
	return nil
}

func (s Snapshot) Validate() error {
	if s.SchemaVersion != SnapshotSchemaVersion || s.EntityVersion <= 0 ||
		s.ID == "" || s.Type == "" || s.State == "" ||
		!validCancellationStatus(s.Cancellation.Status) ||
		s.CreatedAt.IsZero() || s.UpdatedAt.IsZero() ||
		s.Progress.Completed < 0 {
		return ErrInvalidSnapshot
	}
	if s.Progress.Total != nil && *s.Progress.Total < s.Progress.Completed {
		return ErrInvalidSnapshot
	}
	for _, attempt := range s.Executions {
		if attempt.ID == "" || attempt.Attempt <= 0 || attempt.Runtime == "" ||
			attempt.State == "" || attempt.Version <= 0 {
			return ErrInvalidSnapshot
		}
	}
	return nil
}

func validCancellationStatus(status string) bool {
	switch status {
	case "none", "requested", "acknowledged", "cancelled", "too_late",
		"cannot_cancel_safely", "failed":
		return true
	default:
		return false
	}
}
