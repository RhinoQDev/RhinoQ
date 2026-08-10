package postgres_test

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"strings"
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

func TestPublicWaitpointPersistsIdempotentSettlement(t *testing.T) {
	if testDB == nil {
		t.Skip("set RHINOQ_TEST_DATABASE_URL to run the PostgreSQL harness")
	}
	truncate(t)
	client, err := rhinoq.NewPostgres(testDB)
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	created, err := client.CreateTask(ctx, rhinoq.TaskCreateRequest{ID: "task-waitpoint", Type: "report.review", OwnerID: "owner-1", DefinitionVersion: 1})
	if err != nil {
		t.Fatal(err)
	}
	deadline := databaseNow(t).Add(time.Hour)
	wait, replayed, err := client.CreateTaskWaitpoint(ctx, created.ID, rhinoq.TaskWaitpointCreateRequest{ID: "wp-review", Key: "review", Kind: "approval", PayloadVersion: 1, Deadline: deadline})
	if err != nil || replayed || wait.State != "waiting" {
		t.Fatalf("create: %+v replay=%v err=%v", wait, replayed, err)
	}
	parent, err := client.GetTask(ctx, created.ID)
	if err != nil || parent.EntityVersion != created.EntityVersion+1 {
		t.Fatalf("parent version: %+v %v", parent, err)
	}
	request := rhinoq.TaskWaitpointResolveRequest{OwnerID: "owner-1", ResolutionID: "submit-1", Actor: "owner-1", ExpectedVersion: wait.EntityVersion, Resolution: []byte(`{"approved":true}`)}
	resolved, err := client.ResolveTaskWaitpoint(ctx, wait.ID, request)
	if err != nil {
		t.Fatal(err)
	}
	replayedResult, err := client.ResolveTaskWaitpoint(ctx, wait.ID, request)
	if err != nil || replayedResult.EntityVersion != resolved.EntityVersion {
		t.Fatalf("replay: %+v %v", replayedResult, err)
	}
	parentAfterReplay, err := client.GetTask(ctx, created.ID)
	if err != nil || parentAfterReplay.EntityVersion != parent.EntityVersion+1 {
		t.Fatalf("duplicate settlement advanced parent: %+v %v", parentAfterReplay, err)
	}
	var resumeEvents int
	if err = testDB.QueryRowContext(ctx, `SELECT count(*) FROM rhinoq_outbox WHERE event_type='task.waitpoint.resolved' AND aggregate_id=$1`, wait.ID).Scan(&resumeEvents); err != nil || resumeEvents != 1 {
		t.Fatalf("resume events=%d err=%v", resumeEvents, err)
	}
	request.Resolution = []byte(`{"approved":false}`)
	if _, err = client.ResolveTaskWaitpoint(ctx, wait.ID, request); err == nil {
		t.Fatal("conflicting resolution was accepted")
	}
	if _, err = client.GetTaskWaitpoint(ctx, wait.ID, "other-owner"); !errors.Is(err, rhinoq.ErrWaitpointNotFound) {
		t.Fatalf("owner isolation: %v", err)
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

func TestTaskRetryCommitsOneCommandExecutionAndOutboxUnderConcurrency(t *testing.T) {
	if testDB == nil {
		t.Skip("set RHINOQ_TEST_DATABASE_URL to run the PostgreSQL harness")
	}
	truncate(t)
	store, err := postgres.NewTaskStore(testDB)
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	now := time.Date(2026, 8, 9, 18, 0, 0, 0, time.UTC)
	record, err := task.NewRecord(task.Spec{ID: "task-retry-real", Type: "report.generate", DefinitionVersion: 1, Now: now})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = store.CreateTask(ctx, record); err != nil {
		t.Fatal(err)
	}
	for _, state := range []task.State{task.Queued, task.Running, task.Failed} {
		next, transitionErr := record.Transition(state, now.Add(time.Duration(record.Version)*time.Second))
		if transitionErr != nil {
			t.Fatal(transitionErr)
		}
		record, err = store.UpdateTask(ctx, next, record.Version)
		if err != nil {
			t.Fatal(err)
		}
	}
	input := ports.TaskRetryInput{CommandID: "retry-real-1", TaskID: record.ID, ExpectedVersion: record.Version,
		ExecutionID: "exec-retry-real-1", Runtime: "bullmq", Queue: "reports", JobName: "generate",
		Payload: []byte(`{"reportId":"r-1"}`), Now: now.Add(time.Minute)}

	results := make(chan ports.TaskRetryResult, 2)
	errorsFound := make(chan error, 2)
	var group sync.WaitGroup
	for range 2 {
		group.Add(1)
		go func() {
			defer group.Done()
			result, retryErr := store.RetryTask(ctx, input)
			if retryErr != nil {
				errorsFound <- retryErr
				return
			}
			results <- result
		}()
	}
	group.Wait()
	close(results)
	close(errorsFound)
	for retryErr := range errorsFound {
		t.Errorf("concurrent retry: %v", retryErr)
	}
	if len(results) != 2 {
		t.Fatalf("both identical commands must converge, got %d", len(results))
	}

	var commands, executions, events int
	if err := testDB.QueryRowContext(ctx, `SELECT
		(SELECT count(*) FROM rhinoq_task_retry_commands WHERE command_id='retry-real-1'),
		(SELECT count(*) FROM rhinoq_task_executions WHERE id='exec-retry-real-1'),
		(SELECT count(*) FROM rhinoq_outbox WHERE event_type='task.retry.dispatch_requested' AND aggregate_id='task-retry-real')`).Scan(&commands, &executions, &events); err != nil {
		t.Fatal(err)
	}
	if commands != 1 || executions != 1 || events != 1 {
		t.Fatalf("retry forked durable state: commands=%d executions=%d events=%d", commands, executions, events)
	}
	var payload string
	if err := testDB.QueryRowContext(ctx, `SELECT payload::text FROM rhinoq_outbox WHERE aggregate_id='task-retry-real'`).Scan(&payload); err != nil {
		t.Fatal(err)
	}
	for _, expected := range []string{`"queue": "reports"`, `"jobName": "generate"`, `"executionId": "exec-retry-real-1"`} {
		if !strings.Contains(payload, expected) {
			t.Fatalf("outbox payload missing %s: %s", expected, payload)
		}
	}
}
