package tasks

import (
	"context"
	"errors"
	"reflect"
	"testing"
	"time"

	"github.com/madebyduy/RhinoQ/internal/adapters/memory"
	"github.com/madebyduy/RhinoQ/internal/domain/execution"
	"github.com/madebyduy/RhinoQ/internal/domain/task"
	"github.com/madebyduy/RhinoQ/internal/ports"
)

func TestCreateBindAndReadTaskSnapshot(t *testing.T) {
	ctx := context.Background()
	now := time.Date(2026, 7, 29, 13, 0, 0, 0, time.UTC)
	store := memory.NewTaskStore()
	service, err := New(store, store, func() time.Time {
		now = now.Add(time.Second)
		return now
	})
	if err != nil {
		t.Fatal(err)
	}
	taskRecord, err := service.Create(ctx, CreateInput{ID: "task-1", Type: "report.export", OwnerID: "user-1", DefinitionVersion: 1})
	if err != nil {
		t.Fatal(err)
	}
	executionRecord, err := service.CreateExecution(ctx, CreateExecutionInput{ID: "exec-1", TaskID: taskRecord.ID, Runtime: execution.RuntimeNative})
	if err != nil {
		t.Fatal(err)
	}
	executionRecord, err = service.BindExecution(ctx, executionRecord.ID, execution.RuntimeReference{Runtime: execution.RuntimeNative, JobID: "job-1"})
	if err != nil {
		t.Fatal(err)
	}
	snapshot, err := service.Get(ctx, taskRecord.ID)
	if err != nil {
		t.Fatal(err)
	}
	if snapshot.ID != taskRecord.ID.String() || len(snapshot.Executions) != 1 || snapshot.Executions[0].ID != "exec-1" {
		t.Fatalf("unexpected snapshot: %+v", snapshot)
	}
	if snapshot.EntityVersion != taskRecord.Version+2 {
		t.Fatalf("create and bind must each advance aggregate version: %+v", snapshot)
	}
	if _, err := service.Transition(
		ctx, taskRecord.ID, taskRecord.Version, task.Queued,
	); !errors.Is(err, ports.ErrVersionConflict) {
		t.Fatalf("a command from before execution changes must be stale, got %v", err)
	}
}

func TestLifecycleAndProgressCommandsFenceStaleVersions(t *testing.T) {
	ctx := context.Background()
	now := time.Date(2026, 7, 29, 13, 0, 0, 0, time.UTC)
	store := memory.NewTaskStore()
	service, err := New(store, store, func() time.Time {
		now = now.Add(time.Second)
		return now
	})
	if err != nil {
		t.Fatal(err)
	}
	record, err := service.Create(ctx, CreateInput{ID: "task-1", Type: "import", DefinitionVersion: 1})
	if err != nil {
		t.Fatal(err)
	}
	queued, err := service.Transition(ctx, record.ID, record.Version, task.Queued)
	if err != nil {
		t.Fatal(err)
	}
	running, err := service.Transition(ctx, record.ID, queued.EntityVersion, task.Running)
	if err != nil {
		t.Fatal(err)
	}
	progressed, err := service.UpdateProgress(ctx, record.ID, running.EntityVersion, task.Progress{
		Completed: 4, Total: 10, HasTotal: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	if progressed.Progress.Total == nil || *progressed.Progress.Total != 10 || progressed.EntityVersion != 4 {
		t.Fatalf("unexpected progress snapshot: %+v", progressed)
	}
	if _, err := service.UpdateProgress(ctx, record.ID, running.EntityVersion, task.Progress{Completed: 5}); !errors.Is(err, ports.ErrVersionConflict) {
		t.Fatalf("expected stale command rejection, got %v", err)
	}
}

// GAP-5: a duplicate is what a reconnecting fan-out bridge produces. It must
// neither consume a version nor be answered with a conflict, even when the
// writer's expectedVersion has been overtaken.
func TestDuplicateProgressAndCancellationCommandsAreIdempotent(t *testing.T) {
	ctx := context.Background()
	now := time.Date(2026, 7, 29, 13, 0, 0, 0, time.UTC)
	store := memory.NewTaskStore()
	service, err := New(store, store, func() time.Time {
		now = now.Add(time.Second)
		return now
	})
	if err != nil {
		t.Fatal(err)
	}
	record, err := service.Create(ctx, CreateInput{ID: "task-1", Type: "bulk-download", DefinitionVersion: 1})
	if err != nil {
		t.Fatal(err)
	}
	queued, err := service.Transition(ctx, record.ID, record.Version, task.Queued)
	if err != nil {
		t.Fatal(err)
	}
	running, err := service.Transition(ctx, record.ID, queued.EntityVersion, task.Running)
	if err != nil {
		t.Fatal(err)
	}
	progress := task.Progress{Completed: 6, Total: 10, HasTotal: true}
	first, err := service.UpdateProgress(ctx, record.ID, running.EntityVersion, progress)
	if err != nil {
		t.Fatal(err)
	}
	for attempt := 0; attempt < 3; attempt++ {
		repeated, err := service.UpdateProgress(ctx, record.ID, first.EntityVersion, progress)
		if err != nil {
			t.Fatal(err)
		}
		if repeated.EntityVersion != first.EntityVersion || !reflect.DeepEqual(repeated, first) {
			t.Fatalf("re-delivery %d changed the snapshot: got=%+v want=%+v", attempt, repeated, first)
		}
	}
	// The stale writer is the one this used to punish: its version is behind
	// only because a duplicate moved it.
	stale, err := service.UpdateProgress(ctx, record.ID, running.EntityVersion, progress)
	if err != nil {
		t.Fatalf("an identical write cannot lose an update, so it must not conflict: %v", err)
	}
	if stale.EntityVersion != first.EntityVersion {
		t.Fatalf("no-op must not advance the version: %+v", stale)
	}

	requested, err := service.RequestCancellation(ctx, record.ID, first.EntityVersion)
	if err != nil {
		t.Fatal(err)
	}
	if requested.State != string(task.CancelRequested) ||
		requested.EntityVersion != first.EntityVersion+1 {
		t.Fatalf("unexpected cancellation snapshot: %+v", requested)
	}
	repeated, err := service.RequestCancellation(ctx, record.ID, first.EntityVersion)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(repeated, requested) {
		t.Fatalf("repeated cancellation must be a no-op: got=%+v want=%+v", repeated, requested)
	}
	// Progress still flows while cancellation is pending, and a real change is
	// still fenced.
	if _, err := service.UpdateProgress(
		ctx, record.ID, first.EntityVersion, task.Progress{Completed: 7, Total: 10, HasTotal: true},
	); !errors.Is(err, ports.ErrVersionConflict) {
		t.Fatalf("a genuine change from a stale version must still conflict, got %v", err)
	}
}

func TestCreateExecutionNumbersAttempts(t *testing.T) {
	ctx := context.Background()
	now := time.Date(2026, 7, 29, 13, 0, 0, 0, time.UTC)
	store := memory.NewTaskStore()
	service, err := New(store, store, func() time.Time { return now })
	if err != nil {
		t.Fatal(err)
	}
	record, err := service.Create(ctx, CreateInput{ID: "task-1", Type: "import", DefinitionVersion: 1})
	if err != nil {
		t.Fatal(err)
	}
	first, err := service.CreateExecution(ctx, CreateExecutionInput{ID: "exec-1", TaskID: record.ID, Runtime: "bullmq"})
	if err != nil {
		t.Fatal(err)
	}
	second, err := service.CreateExecution(ctx, CreateExecutionInput{ID: "exec-2", TaskID: record.ID, Runtime: "bullmq"})
	if err != nil {
		t.Fatal(err)
	}
	if first.Attempt != 1 || second.Attempt != 2 {
		t.Fatalf("attempts must be monotonic: first=%d second=%d", first.Attempt, second.Attempt)
	}
}

func TestAttachAndReadResultUsesVersionFence(t *testing.T) {
	ctx := context.Background()
	now := time.Date(2026, 7, 29, 13, 0, 0, 0, time.UTC)
	store := memory.NewTaskStore()
	service, err := New(store, store, func() time.Time {
		now = now.Add(time.Second)
		return now
	})
	if err != nil {
		t.Fatal(err)
	}
	record, err := service.Create(ctx, CreateInput{
		ID: "task-1", Type: "report.export", DefinitionVersion: 1,
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := service.GetResult(ctx, record.ID); !errors.Is(err, ports.ErrTaskResultNotFound) {
		t.Fatalf("expected absent result, got %v", err)
	}
	result, err := service.AttachResult(
		ctx, record.ID, record.Version, "s3://reports/report-1.pdf",
	)
	if err != nil {
		t.Fatal(err)
	}
	if result.Reference != "s3://reports/report-1.pdf" ||
		result.EntityVersion != record.Version+1 {
		t.Fatalf("unexpected result: %+v", result)
	}
	if _, err := service.AttachResult(
		ctx, record.ID, record.Version, "s3://reports/stale.pdf",
	); !errors.Is(err, ports.ErrVersionConflict) {
		t.Fatalf("expected stale result write to fail, got %v", err)
	}
	loaded, err := service.GetResult(ctx, record.ID)
	if err != nil {
		t.Fatal(err)
	}
	if loaded != result {
		t.Fatalf("result round trip drifted: got=%+v want=%+v", loaded, result)
	}
}
