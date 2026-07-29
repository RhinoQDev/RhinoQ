package postgres_test

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"sync"
	"testing"
	"time"

	"github.com/madebyduy/RhinoQ/internal/adapters/postgres"
	"github.com/madebyduy/RhinoQ/internal/domain/execution"
	"github.com/madebyduy/RhinoQ/internal/domain/task"
	"github.com/madebyduy/RhinoQ/internal/ports"
	"github.com/madebyduy/RhinoQ/pkg/rhinoq"
)

func TestPublicTaskFacadeUsesPostgres(t *testing.T) {
	if testDB == nil {
		t.Skip("set RHINOQ_TEST_DATABASE_URL to run the PostgreSQL harness")
	}
	truncate(t)
	client, err := rhinoq.NewPostgres(testDB)
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	created, err := client.CreateTask(ctx, rhinoq.TaskCreateRequest{
		ID: "task-public", Type: "report.export", OwnerID: "tenant-acme",
		DefinitionVersion: 1,
	})
	if err != nil {
		t.Fatal(err)
	}
	withExecution, err := client.CreateTaskExecution(
		ctx,
		created.ID,
		rhinoq.TaskExecutionCreateRequest{ID: "exec-public", Runtime: "bullmq"},
	)
	if err != nil {
		t.Fatal(err)
	}
	bound, err := client.BindTaskExecution(
		ctx,
		"exec-public",
		rhinoq.TaskExecutionBinding{Runtime: "bullmq", ExternalID: "bull-public"},
	)
	if err != nil {
		t.Fatal(err)
	}
	if bound.EntityVersion != withExecution.EntityVersion+1 {
		t.Fatalf("binding did not advance PostgreSQL aggregate version: %+v", bound)
	}
	queued, err := client.QueueTask(ctx, created.ID, created.EntityVersion)
	if !errors.Is(err, rhinoq.ErrTaskVersionConflict) {
		t.Fatalf("pre-execution task version must be stale, got %v", err)
	}
	queued, err = client.QueueTask(ctx, created.ID, bound.EntityVersion)
	if err != nil {
		t.Fatal(err)
	}
	polled, err := client.GetTask(ctx, created.ID)
	if err != nil {
		t.Fatal(err)
	}
	if polled.State != rhinoq.TaskQueued ||
		polled.EntityVersion != queued.EntityVersion ||
		polled.OwnerID != "tenant-acme" ||
		polled.Cancellation.Status != "none" {
		t.Fatalf("public facade did not round-trip through PostgreSQL: %+v", polled)
	}
	result, err := client.AttachTaskResult(
		ctx,
		polled.ID,
		polled.EntityVersion,
		"s3://reports/task-public.pdf",
	)
	if err != nil {
		t.Fatal(err)
	}
	loadedResult, err := client.GetTaskResult(ctx, polled.ID)
	if err != nil {
		t.Fatal(err)
	}
	if loadedResult.Reference != result.Reference ||
		loadedResult.EntityVersion != result.EntityVersion {
		t.Fatalf("result reference did not round-trip through PostgreSQL: %+v", loadedResult)
	}
}

// The no-op path skips UpdateTask entirely, so the thing worth proving against
// a real database is that nothing was written: the stored row, not just the
// returned snapshot, must still carry the original version.
func TestPostgresDoesNotWriteDuplicateProgressOrCancellation(t *testing.T) {
	if testDB == nil {
		t.Skip("set RHINOQ_TEST_DATABASE_URL to run the PostgreSQL harness")
	}
	truncate(t)
	client, err := rhinoq.NewPostgres(testDB)
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	snapshot, err := client.CreateTask(ctx, rhinoq.TaskCreateRequest{
		ID: "task-duplicate", Type: "bulk-download", DefinitionVersion: 1,
	})
	if err != nil {
		t.Fatal(err)
	}
	if snapshot, err = client.QueueTask(ctx, snapshot.ID, snapshot.EntityVersion); err != nil {
		t.Fatal(err)
	}
	if snapshot, err = client.StartTask(ctx, snapshot.ID, snapshot.EntityVersion); err != nil {
		t.Fatal(err)
	}
	total := int64(10)
	progress := rhinoq.TaskProgress{Completed: 6, Total: &total}
	snapshot, err = client.ReportTaskProgress(ctx, snapshot.ID, snapshot.EntityVersion, progress)
	if err != nil {
		t.Fatal(err)
	}
	written := snapshot.EntityVersion
	storedVersion, storedUpdatedAt := storedTaskRow(t, snapshot.ID)

	for attempt := 0; attempt < 3; attempt++ {
		repeated, err := client.ReportTaskProgress(ctx, snapshot.ID, written, progress)
		if err != nil {
			t.Fatalf("re-delivery %d was refused: %v", attempt, err)
		}
		if repeated.EntityVersion != written {
			t.Fatalf("re-delivery %d advanced the version: %+v", attempt, repeated)
		}
	}
	if version, updatedAt := storedTaskRow(t, snapshot.ID); version != storedVersion ||
		!updatedAt.Equal(storedUpdatedAt) {
		t.Fatalf(
			"duplicates reached the row: version %d→%d, updatedAt %s→%s",
			storedVersion, version, storedUpdatedAt, updatedAt,
		)
	}

	cancelled, err := client.RequestTaskCancellation(ctx, snapshot.ID, written)
	if err != nil {
		t.Fatal(err)
	}
	if cancelled.EntityVersion != written+1 ||
		cancelled.Cancellation.Status != "requested" {
		t.Fatalf("unexpected cancellation snapshot: %+v", cancelled)
	}
	repeated, err := client.RequestTaskCancellation(ctx, snapshot.ID, written)
	if err != nil {
		t.Fatalf("a repeated cancellation request was refused: %v", err)
	}
	if repeated.EntityVersion != cancelled.EntityVersion {
		t.Fatalf("repeated cancellation advanced the version: %+v", repeated)
	}
	// A real change from the same stale version is still fenced.
	if _, err := client.ReportTaskProgress(
		ctx, snapshot.ID, written, rhinoq.TaskProgress{Completed: 7, Total: &total},
	); !errors.Is(err, rhinoq.ErrTaskVersionConflict) {
		t.Fatalf("a genuine stale write must still conflict, got %v", err)
	}
}

// Per-item outcome is what lets a fan-out drop its parallel item store, so it
// has to survive the round trip through real columns, not just memory.
func TestPostgresPersistsPerExecutionOutcome(t *testing.T) {
	if testDB == nil {
		t.Skip("set RHINOQ_TEST_DATABASE_URL to run the PostgreSQL harness")
	}
	truncate(t)
	client, err := rhinoq.NewPostgres(testDB)
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	if _, err := client.CreateTask(ctx, rhinoq.TaskCreateRequest{
		ID: "task-batch", Type: "bulk-download", OwnerID: "tenant-acme",
		DefinitionVersion: 1,
	}); err != nil {
		t.Fatal(err)
	}
	for _, item := range []struct{ execution, job string }{
		{"exec-1", "bull-1"}, {"exec-2", "bull-2"},
	} {
		if _, err := client.CreateTaskExecution(ctx, "task-batch",
			rhinoq.TaskExecutionCreateRequest{ID: item.execution, Runtime: "bullmq"}); err != nil {
			t.Fatal(err)
		}
		if _, err := client.BindTaskExecution(ctx, item.execution,
			rhinoq.TaskExecutionBinding{Runtime: "bullmq", ExternalID: item.job}); err != nil {
			t.Fatal(err)
		}
	}

	advance := func(id string, state string) rhinoq.TaskExecution {
		t.Helper()
		current, err := client.GetTaskExecution(ctx, id)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := client.TransitionTaskExecution(ctx, id, current.Version, state); err != nil {
			t.Fatal(err)
		}
		current, err = client.GetTaskExecution(ctx, id)
		if err != nil {
			t.Fatal(err)
		}
		return current
	}

	advance("exec-1", "running")
	succeeded := advance("exec-1", "succeeded")
	if _, err := client.AttachTaskExecutionResult(
		ctx, "exec-1", succeeded.Version, "s3://videos/batch/item-1.mp4",
	); err != nil {
		t.Fatal(err)
	}

	advance("exec-2", "running")
	running, err := client.GetTaskExecution(ctx, "exec-2")
	if err != nil {
		t.Fatal(err)
	}
	snapshot, err := client.FailTaskExecution(
		ctx, "exec-2", running.Version, "source mirror returned 404 after 3 attempts",
	)
	if err != nil {
		t.Fatal(err)
	}
	for _, attempt := range snapshot.Executions {
		switch attempt.ID {
		case "exec-1":
			if !attempt.HasResult || attempt.FailureReason != "" {
				t.Fatalf("succeeded attempt lost its outcome: %+v", attempt)
			}
		case "exec-2":
			if attempt.HasResult ||
				attempt.FailureReason != "source mirror returned 404 after 3 attempts" {
				t.Fatalf("failed attempt lost its reason: %+v", attempt)
			}
		}
	}

	results, err := client.GetTaskExecutionResults(ctx, "task-batch")
	if err != nil {
		t.Fatal(err)
	}
	if results.EntityVersion != snapshot.EntityVersion || len(results.Executions) != 2 {
		t.Fatalf("unexpected execution results: %+v", results)
	}
	if results.Executions[0].Reference != "s3://videos/batch/item-1.mp4" ||
		results.Executions[1].Reference != "" ||
		results.Executions[1].FailureReason != "source mirror returned 404 after 3 attempts" {
		t.Fatalf("per-item outcome did not survive PostgreSQL: %+v", results.Executions)
	}
}

func storedTaskRow(t *testing.T, id string) (int64, time.Time) {
	t.Helper()
	var version int64
	var updatedAt time.Time
	if err := testDB.QueryRowContext(
		context.Background(),
		`SELECT version, updated_at FROM rhinoq_tasks WHERE id=$1`,
		id,
	).Scan(&version, &updatedAt); err != nil {
		t.Fatal(err)
	}
	return version, updatedAt
}

func TestPostgresPersistsCancellationOutcome(t *testing.T) {
	if testDB == nil {
		t.Skip("set RHINOQ_TEST_DATABASE_URL to run the PostgreSQL harness")
	}
	truncate(t)
	client, err := rhinoq.NewPostgres(testDB)
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	snapshot, err := client.CreateTask(ctx, rhinoq.TaskCreateRequest{
		ID: "task-cancel", Type: "export", DefinitionVersion: 1,
	})
	if err != nil {
		t.Fatal(err)
	}
	snapshot, err = client.QueueTask(ctx, snapshot.ID, snapshot.EntityVersion)
	if err != nil {
		t.Fatal(err)
	}
	snapshot, err = client.StartTask(ctx, snapshot.ID, snapshot.EntityVersion)
	if err != nil {
		t.Fatal(err)
	}
	snapshot, err = client.RequestTaskCancellation(ctx, snapshot.ID, snapshot.EntityVersion)
	if err != nil {
		t.Fatal(err)
	}
	snapshot, err = client.ResolveTaskCancellation(
		ctx,
		snapshot.ID,
		snapshot.EntityVersion,
		"acknowledged",
		"worker reached a checkpoint",
	)
	if err != nil {
		t.Fatal(err)
	}
	snapshot, err = client.CompleteTask(ctx, snapshot.ID, snapshot.EntityVersion)
	if err != nil {
		t.Fatal(err)
	}
	loaded, err := client.GetTask(ctx, snapshot.ID)
	if err != nil {
		t.Fatal(err)
	}
	if loaded.State != rhinoq.TaskSucceeded ||
		loaded.Cancellation.Status != "too_late" {
		t.Fatalf("PostgreSQL lost the cancellation race outcome: %+v", loaded)
	}
}

func TestTaskStoreContract(t *testing.T) {
	if testDB == nil {
		t.Skip("set RHINOQ_TEST_DATABASE_URL to run the PostgreSQL harness")
	}
	truncate(t)
	store, err := postgres.NewTaskStore(testDB)
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	now := time.Date(2026, 7, 29, 15, 0, 0, 0, time.UTC)
	record, err := task.NewRecord(task.Spec{
		ID: "task-1", Type: "report.export", OwnerID: "user-1",
		DefinitionVersion: 1, Now: now,
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.CreateTask(ctx, record); err != nil {
		t.Fatal(err)
	}
	first, firstVersion, err := store.CreateNextExecution(ctx, ports.ExecutionCreateInput{
		ID: "exec-1", TaskID: record.ID.String(), Runtime: execution.RuntimeNative, Now: now,
	})
	if err != nil {
		t.Fatal(err)
	}
	second, secondVersion, err := store.CreateNextExecution(ctx, ports.ExecutionCreateInput{
		ID: "exec-2", TaskID: record.ID.String(), Runtime: "bullmq", Now: now,
	})
	if err != nil {
		t.Fatal(err)
	}
	if first.Attempt != 1 || second.Attempt != 2 {
		t.Fatalf("attempt allocation drifted: first=%d second=%d", first.Attempt, second.Attempt)
	}
	if firstVersion != record.Version+1 || secondVersion != firstVersion+1 {
		t.Fatalf("execution creation did not advance task version: first=%d second=%d", firstVersion, secondVersion)
	}
	second, err = second.Bind(execution.RuntimeReference{Runtime: "bullmq", ExternalID: "bull-2"}, now.Add(time.Second))
	if err != nil {
		t.Fatal(err)
	}
	if _, boundVersion, err := store.UpdateExecution(ctx, second, 1); err != nil {
		t.Fatal(err)
	} else if boundVersion != secondVersion+1 {
		t.Fatalf("execution binding did not advance task version: got=%d want=%d", boundVersion, secondVersion+1)
	}
	loaded, found, err := store.GetExecution(ctx, second.ID)
	if err != nil || !found || loaded.Reference.ExternalID != "bull-2" {
		t.Fatalf("execution round trip failed: found=%v record=%+v err=%v", found, loaded, err)
	}
	current, found, err := store.GetTask(ctx, record.ID)
	if err != nil || !found {
		t.Fatalf("load task after execution writes: found=%v err=%v", found, err)
	}
	queued, err := current.Transition(task.Queued, now.Add(time.Second))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.UpdateTask(ctx, queued, current.Version); err != nil {
		t.Fatal(err)
	}
	if _, err := store.UpdateTask(ctx, queued, current.Version); !errors.Is(err, ports.ErrVersionConflict) {
		t.Fatalf("expected version conflict, got %v", err)
	}
}

func TestTaskStoreAllocatesConcurrentAttemptsAtomically(t *testing.T) {
	if testDB == nil {
		t.Skip("set RHINOQ_TEST_DATABASE_URL to run the PostgreSQL harness")
	}
	truncate(t)
	store, err := postgres.NewTaskStore(testDB)
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	now := time.Date(2026, 7, 29, 15, 0, 0, 0, time.UTC)
	record, err := task.NewRecord(task.Spec{
		ID: "task-concurrent", Type: "bulk.import",
		DefinitionVersion: 1, Now: now,
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.CreateTask(ctx, record); err != nil {
		t.Fatal(err)
	}

	const count = 8
	attempts := make(chan int, count)
	errs := make(chan error, count)
	var group sync.WaitGroup
	for index := 0; index < count; index++ {
		group.Add(1)
		go func(index int) {
			defer group.Done()
			created, _, err := store.CreateNextExecution(ctx, ports.ExecutionCreateInput{
				ID: execution.ID(fmt.Sprintf("exec-%d", index)), TaskID: record.ID.String(),
				Runtime: "bullmq", Now: now,
			})
			if err != nil {
				errs <- err
				return
			}
			attempts <- created.Attempt
		}(index)
	}
	group.Wait()
	close(attempts)
	close(errs)
	for err := range errs {
		t.Errorf("create concurrent execution: %v", err)
	}
	got := make([]int, 0, count)
	for attempt := range attempts {
		got = append(got, attempt)
	}
	sort.Ints(got)
	if len(got) != count {
		t.Fatalf("expected %d attempts, got %v", count, got)
	}
	for index, attempt := range got {
		if attempt != index+1 {
			t.Fatalf("attempt allocation has a gap or duplicate: %v", got)
		}
	}
	updatedTask, found, err := store.GetTask(ctx, record.ID)
	if err != nil || !found {
		t.Fatalf("load task after concurrent attempts: found=%v err=%v", found, err)
	}
	if updatedTask.Version != record.Version+count {
		t.Fatalf("task version must include every attempt: got=%d want=%d", updatedTask.Version, record.Version+count)
	}
}
