package task

import (
	"errors"
	"testing"
	"time"
)

func TestRecordMutationsAdvanceVersion(t *testing.T) {
	now := time.Date(2026, 7, 29, 10, 0, 0, 0, time.UTC)
	record, err := NewRecord(Spec{
		ID: "task-1", Type: "report.export", OwnerID: "user-1",
		DefinitionVersion: 1, Now: now,
	})
	if err != nil {
		t.Fatal(err)
	}
	if record.State != Pending || record.Version != 1 {
		t.Fatalf("unexpected initial record: %+v", record)
	}

	record, err = record.Transition(Queued, now.Add(time.Second))
	if err != nil {
		t.Fatal(err)
	}
	record, err = record.Transition(Running, now.Add(2*time.Second))
	if err != nil {
		t.Fatal(err)
	}
	record, err = record.ApplyProgress(Progress{Completed: 4, Total: 10, HasTotal: true}, now.Add(3*time.Second))
	if err != nil {
		t.Fatal(err)
	}
	record, err = record.AttachResult("result://report-1", now.Add(4*time.Second))
	if err != nil {
		t.Fatal(err)
	}
	if record.Version != 5 || record.ResultRef != "result://report-1" {
		t.Fatalf("mutations must advance version: %+v", record)
	}
}

func TestRecordRejectsInvalidProgressAndResult(t *testing.T) {
	now := time.Date(2026, 7, 29, 10, 0, 0, 0, time.UTC)
	record, err := NewRecord(Spec{ID: "task-1", Type: "import", DefinitionVersion: 1, Now: now})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := record.ApplyProgress(Progress{Completed: 2, Total: 1, HasTotal: true}, now.Add(time.Second)); !errors.Is(err, ErrInvalidProgress) {
		t.Fatalf("expected invalid progress, got %v", err)
	}
	if _, err := record.ApplyProgress(Progress{Completed: 1}, now.Add(time.Second)); !errors.Is(err, ErrProgressState) {
		t.Fatalf("expected progress state rejection, got %v", err)
	}
	if _, err := record.AttachResult("  ", now.Add(time.Second)); !errors.Is(err, ErrInvalidResult) {
		t.Fatalf("expected invalid result, got %v", err)
	}
}
