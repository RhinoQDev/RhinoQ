package execution

import (
	"errors"
	"testing"
	"time"
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
