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

func TestRecordRejectsProgressRegressionAndKnownTotalChanges(t *testing.T) {
	now := time.Date(2026, 7, 29, 10, 0, 0, 0, time.UTC)
	record, err := NewRecord(Spec{ID: "task-1", Type: "import", DefinitionVersion: 1, Now: now})
	if err != nil {
		t.Fatal(err)
	}
	record, err = record.Transition(Queued, now.Add(time.Second))
	if err != nil {
		t.Fatal(err)
	}
	record, err = record.Transition(Running, now.Add(2*time.Second))
	if err != nil {
		t.Fatal(err)
	}
	record, err = record.ApplyProgress(
		Progress{Completed: 5, Total: 10, HasTotal: true},
		now.Add(3*time.Second),
	)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := record.ApplyProgress(
		Progress{Completed: 2, Total: 10, HasTotal: true},
		now.Add(4*time.Second),
	); !errors.Is(err, ErrProgressRegression) {
		t.Fatalf("expected progress regression rejection, got %v", err)
	}
	if _, err := record.ApplyProgress(
		Progress{Completed: 6, Total: 12, HasTotal: true},
		now.Add(4*time.Second),
	); !errors.Is(err, ErrProgressTotal) {
		t.Fatalf("expected known total change rejection, got %v", err)
	}
	if _, err := record.ApplyProgress(
		Progress{Completed: 6},
		now.Add(4*time.Second),
	); !errors.Is(err, ErrProgressTotal) {
		t.Fatalf("expected known total removal rejection, got %v", err)
	}
}

func TestCancellationOutcomeRemainsVisibleWhenCancelLosesTheRace(t *testing.T) {
	now := time.Date(2026, 7, 29, 10, 0, 0, 0, time.UTC)
	record, err := NewRecord(Spec{ID: "task-1", Type: "export", DefinitionVersion: 1, Now: now})
	if err != nil {
		t.Fatal(err)
	}
	record, err = record.Transition(Queued, now.Add(time.Second))
	if err != nil {
		t.Fatal(err)
	}
	record, err = record.Transition(Running, now.Add(2*time.Second))
	if err != nil {
		t.Fatal(err)
	}
	record, err = record.Transition(CancelRequested, now.Add(3*time.Second))
	if err != nil {
		t.Fatal(err)
	}
	record, err = record.ResolveCancellation(
		CancellationAcknowledged,
		"worker is checking a safe boundary",
		now.Add(4*time.Second),
	)
	if err != nil {
		t.Fatal(err)
	}
	record, err = record.Transition(Succeeded, now.Add(5*time.Second))
	if err != nil {
		t.Fatal(err)
	}
	if record.State != Succeeded || record.CancellationStatus != CancellationTooLate {
		t.Fatalf("success after cancel must preserve too-late outcome: %+v", record)
	}
}

func TestCancellationCanReportUnsafeRefusal(t *testing.T) {
	now := time.Date(2026, 7, 29, 10, 0, 0, 0, time.UTC)
	record, err := NewRecord(Spec{ID: "task-1", Type: "charge", DefinitionVersion: 1, Now: now})
	if err != nil {
		t.Fatal(err)
	}
	record, _ = record.Transition(Queued, now.Add(time.Second))
	record, _ = record.Transition(Running, now.Add(2*time.Second))
	record, _ = record.Transition(CancelRequested, now.Add(3*time.Second))
	record, err = record.ResolveCancellation(
		CancellationCannotCancel,
		"provider request may already have been accepted",
		now.Add(4*time.Second),
	)
	if err != nil {
		t.Fatal(err)
	}
	if record.CancellationStatus != CancellationCannotCancel ||
		record.CancellationReason == "" {
		t.Fatalf("unsafe refusal must be explicit: %+v", record)
	}
}

func TestRetryStartsANewCancellationLifecycle(t *testing.T) {
	now := time.Date(2026, 7, 29, 10, 0, 0, 0, time.UTC)
	record, err := NewRecord(Spec{ID: "task-1", Type: "export", DefinitionVersion: 1, Now: now})
	if err != nil {
		t.Fatal(err)
	}
	record, _ = record.Transition(Queued, now.Add(time.Second))
	record, _ = record.Transition(CancelRequested, now.Add(2*time.Second))
	record, _ = record.Transition(Cancelled, now.Add(3*time.Second))
	record.CancellationReason = "old attempt"
	record, err = record.Transition(Queued, now.Add(4*time.Second))
	if err != nil {
		t.Fatal(err)
	}
	if record.CancellationStatus != CancellationNone || record.CancellationReason != "" {
		t.Fatalf("retry must start a fresh cancellation lifecycle: %+v", record)
	}
}
