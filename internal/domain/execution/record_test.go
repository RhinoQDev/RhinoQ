package execution

import (
	"errors"
	"strings"
	"testing"
	"time"
	"unicode/utf8"
)

func TestNativeExecutionBindsJob(t *testing.T) {
	now := time.Date(2026, 7, 29, 11, 0, 0, 0, time.UTC)
	record, err := NewRecord(Spec{
		ID: "exec-1", TaskID: "task-1", Attempt: 1,
		Runtime: RuntimeNative, Now: now,
	})
	if err != nil {
		t.Fatal(err)
	}
	record, err = record.Bind(RuntimeReference{Runtime: RuntimeNative, JobID: "job-1"}, now.Add(time.Second))
	if err != nil {
		t.Fatal(err)
	}
	if record.State != Dispatched || record.Reference.JobID != "job-1" || record.Version != 2 {
		t.Fatalf("unexpected native execution: %+v", record)
	}
	if _, err := record.Bind(RuntimeReference{Runtime: RuntimeNative, JobID: "job-2"}, now.Add(2*time.Second)); !errors.Is(err, ErrAlreadyBound) {
		t.Fatalf("expected immutable binding, got %v", err)
	}
}

func TestExternalExecutionRequiresExternalReference(t *testing.T) {
	now := time.Date(2026, 7, 29, 11, 0, 0, 0, time.UTC)
	record, err := NewRecord(Spec{
		ID: "exec-2", TaskID: "task-1", Attempt: 2,
		Runtime: "bullmq", Now: now,
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := record.Bind(RuntimeReference{Runtime: "bullmq", JobID: "job-2"}, now.Add(time.Second)); !errors.Is(err, ErrInvalidReference) {
		t.Fatalf("expected external reference validation, got %v", err)
	}
	record, err = record.Bind(RuntimeReference{Runtime: "bullmq", ExternalID: "bull-job-2"}, now.Add(time.Second))
	if err != nil {
		t.Fatal(err)
	}
	if record.Reference.ExternalID != "bull-job-2" {
		t.Fatalf("external execution was not bound: %+v", record)
	}
}

func TestExecutionRecordsPerAttemptOutcome(t *testing.T) {
	now := time.Date(2026, 7, 29, 10, 0, 0, 0, time.UTC)
	record := runningRecord(t, now)
	withResult, err := record.AttachResult("  s3://videos/item-2.mp4  ", now.Add(2*time.Second))
	if err != nil {
		t.Fatal(err)
	}
	if withResult.ResultRef != "s3://videos/item-2.mp4" ||
		withResult.Version != record.Version+1 {
		t.Fatalf("unexpected result attachment: %+v", withResult)
	}
	repeated, err := withResult.AttachResult("s3://videos/item-2.mp4", now.Add(3*time.Second))
	if err != nil {
		t.Fatal(err)
	}
	if repeated.Version != withResult.Version {
		t.Fatalf("re-attaching the same reference must be a no-op: %+v", repeated)
	}
	if _, err := record.AttachResult("   ", now.Add(2*time.Second)); !errors.Is(err, ErrInvalidResult) {
		t.Fatalf("expected an empty reference to be refused, got %v", err)
	}

	failed, err := record.Fail("source mirror returned 404", now.Add(2*time.Second))
	if err != nil {
		t.Fatal(err)
	}
	if failed.State != Failed || failed.FailureReason != "source mirror returned 404" {
		t.Fatalf("unexpected failure: %+v", failed)
	}
}

// The reason is polled with every snapshot, so an unbounded provider error
// would make a 50-item batch ship it 50 times.
func TestExecutionFailureReasonIsBoundedOnRuneBoundaries(t *testing.T) {
	now := time.Date(2026, 7, 29, 10, 0, 0, 0, time.UTC)
	record := runningRecord(t, now)
	failed, err := record.Fail(strings.Repeat("đ", MaxFailureReasonLength+50), now.Add(2*time.Second))
	if err != nil {
		t.Fatal(err)
	}
	reason := []rune(failed.FailureReason)
	if len(reason) != MaxFailureReasonLength+1 || reason[len(reason)-1] != '…' {
		t.Fatalf("reason was not truncated on a rune boundary: %d runes", len(reason))
	}
	if !utf8.ValidString(failed.FailureReason) {
		t.Fatal("truncation produced invalid UTF-8")
	}
}

func runningRecord(t *testing.T, now time.Time) Record {
	t.Helper()
	record, err := NewRecord(Spec{
		ID: "exec-1", TaskID: "task-1", Attempt: 1, Runtime: "bullmq", Now: now,
	})
	if err != nil {
		t.Fatal(err)
	}
	record, err = record.Bind(RuntimeReference{Runtime: "bullmq", ExternalID: "bull-1"}, now)
	if err != nil {
		t.Fatal(err)
	}
	record, err = record.Transition(Running, now.Add(time.Second))
	if err != nil {
		t.Fatal(err)
	}
	return record
}

func TestRetryCreatesNewExecutionInsteadOfReopeningTerminalOne(t *testing.T) {
	now := time.Date(2026, 7, 29, 11, 0, 0, 0, time.UTC)
	record, err := NewRecord(Spec{ID: "exec-1", TaskID: "task-1", Attempt: 1, Runtime: RuntimeNative, Now: now})
	if err != nil {
		t.Fatal(err)
	}
	record, err = record.Bind(RuntimeReference{Runtime: RuntimeNative, JobID: "job-1"}, now.Add(time.Second))
	if err != nil {
		t.Fatal(err)
	}
	record, err = record.Transition(Running, now.Add(2*time.Second))
	if err != nil {
		t.Fatal(err)
	}
	record, err = record.Transition(Failed, now.Add(3*time.Second))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := record.Transition(Dispatched, now.Add(4*time.Second)); err == nil {
		t.Fatal("a terminal execution must not be reopened for retry")
	}
}
