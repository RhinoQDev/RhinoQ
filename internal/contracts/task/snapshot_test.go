package task

import (
	"errors"
	"testing"
	"time"
)

func TestSnapshotValidateRejectsMalformedWireData(t *testing.T) {
	now := time.Date(2026, 7, 29, 14, 0, 0, 0, time.UTC)
	total := int64(2)
	snapshot := Snapshot{
		SchemaVersion: SnapshotSchemaVersion,
		EntityVersion: 1,
		ID:            "task-1",
		Type:          "import",
		State:         "running",
		Progress:      Progress{Completed: 3, Total: &total},
		CreatedAt:     now,
		UpdatedAt:     now,
	}
	if err := snapshot.Validate(); !errors.Is(err, ErrInvalidSnapshot) {
		t.Fatalf("expected invalid progress to fail validation, got %v", err)
	}
}

func TestResultValidateRequiresReference(t *testing.T) {
	result := Result{
		SchemaVersion: ResultSchemaVersion,
		EntityVersion: 2,
		TaskID:        "task-1",
		UpdatedAt:     time.Now(),
	}
	if err := result.Validate(); !errors.Is(err, ErrInvalidResult) {
		t.Fatalf("expected missing reference to fail, got %v", err)
	}
}
