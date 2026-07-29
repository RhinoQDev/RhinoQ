package unit

import (
	"context"
	"errors"
	"testing"

	"github.com/madebyduy/RhinoQ/pkg/rhinoq"
)

func TestPublicTaskFacadeSupportsPollingAndVersionFencedCommands(t *testing.T) {
	ctx := context.Background()
	client := rhinoq.NewInMemory()
	snapshot, err := client.CreateTask(ctx, rhinoq.TaskCreateRequest{
		ID: "task-1", Type: "report.export", OwnerID: "user-1", DefinitionVersion: 1,
	})
	if err != nil {
		t.Fatal(err)
	}
	if snapshot.State != rhinoq.TaskPending || snapshot.EntityVersion != 1 {
		t.Fatalf("unexpected initial task: %+v", snapshot)
	}
	snapshot, err = client.QueueTask(ctx, snapshot.ID, snapshot.EntityVersion)
	if err != nil {
		t.Fatal(err)
	}
	snapshot, err = client.StartTask(ctx, snapshot.ID, snapshot.EntityVersion)
	if err != nil {
		t.Fatal(err)
	}
	total := int64(10)
	progressed, err := client.ReportTaskProgress(ctx, snapshot.ID, snapshot.EntityVersion, rhinoq.TaskProgress{
		Completed: 4, Total: &total, Message: "exporting",
	})
	if err != nil {
		t.Fatal(err)
	}
	if progressed.Progress.Total == nil || *progressed.Progress.Total != total {
		t.Fatalf("unexpected progress: %+v", progressed.Progress)
	}
	if _, err := client.CompleteTask(ctx, snapshot.ID, snapshot.EntityVersion); !errors.Is(err, rhinoq.ErrTaskVersionConflict) {
		t.Fatalf("expected stale version to be rejected, got %v", err)
	}
	polled, err := client.GetTask(ctx, snapshot.ID)
	if err != nil {
		t.Fatal(err)
	}
	if polled.EntityVersion != progressed.EntityVersion || polled.Progress.Completed != 4 {
		t.Fatalf("polling did not return latest snapshot: %+v", polled)
	}
}

func TestPublicTaskFacadeDoesNotExposeOwner(t *testing.T) {
	client := rhinoq.NewInMemory()
	snapshot, err := client.CreateTask(context.Background(), rhinoq.TaskCreateRequest{
		ID: "task-1", Type: "import", OwnerID: "private-owner", DefinitionVersion: 1,
	})
	if err != nil {
		t.Fatal(err)
	}
	if snapshot.ID != "task-1" {
		t.Fatalf("unexpected task: %+v", snapshot)
	}
}

func TestPublicTaskFacadeStoresResultReferenceSeparatelyFromSnapshot(t *testing.T) {
	ctx := context.Background()
	client := rhinoq.NewInMemory()
	snapshot, err := client.CreateTask(ctx, rhinoq.TaskCreateRequest{
		ID: "task-1", Type: "report.export", DefinitionVersion: 1,
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := client.GetTaskResult(ctx, snapshot.ID); !errors.Is(err, rhinoq.ErrTaskResultNotFound) {
		t.Fatalf("expected result-not-found, got %v", err)
	}
	result, err := client.AttachTaskResult(
		ctx,
		snapshot.ID,
		snapshot.EntityVersion,
		"s3://reports/report-1.pdf",
	)
	if err != nil {
		t.Fatal(err)
	}
	latest, err := client.GetTask(ctx, snapshot.ID)
	if err != nil {
		t.Fatal(err)
	}
	if !latest.HasResult || latest.EntityVersion != result.EntityVersion {
		t.Fatalf("snapshot must advertise result availability: %+v", latest)
	}
	loaded, err := client.GetTaskResult(ctx, snapshot.ID)
	if err != nil {
		t.Fatal(err)
	}
	if loaded.Reference != result.Reference {
		t.Fatalf("unexpected result: %+v", loaded)
	}
}

func TestPublicTaskFacadeBindsExternalExecutionAndAdvancesSnapshotVersion(t *testing.T) {
	ctx := context.Background()
	client := rhinoq.NewInMemory()
	created, err := client.CreateTask(ctx, rhinoq.TaskCreateRequest{
		ID: "task-1", Type: "report.export", DefinitionVersion: 1,
	})
	if err != nil {
		t.Fatal(err)
	}
	withExecution, err := client.CreateTaskExecution(ctx, created.ID, rhinoq.TaskExecutionCreateRequest{
		ID: "exec-1", Runtime: "bullmq",
	})
	if err != nil {
		t.Fatal(err)
	}
	if withExecution.EntityVersion != created.EntityVersion+1 ||
		len(withExecution.Executions) != 1 ||
		withExecution.Executions[0].State != "pending_dispatch" {
		t.Fatalf("unexpected execution snapshot: %+v", withExecution)
	}
	bound, err := client.BindTaskExecution(ctx, "exec-1", rhinoq.TaskExecutionBinding{
		Runtime: "bullmq", ExternalID: "bull-job-1",
	})
	if err != nil {
		t.Fatal(err)
	}
	if bound.EntityVersion != withExecution.EntityVersion+1 ||
		bound.Executions[0].State != "dispatched" {
		t.Fatalf("binding must advance aggregate snapshot: %+v", bound)
	}
	if _, err := client.QueueTask(ctx, created.ID, created.EntityVersion); !errors.Is(err, rhinoq.ErrTaskVersionConflict) {
		t.Fatalf("pre-execution version must be stale, got %v", err)
	}
	if _, err := client.QueueTask(ctx, bound.ID, bound.EntityVersion); err != nil {
		t.Fatalf("latest aggregate version must remain writable: %v", err)
	}
}
