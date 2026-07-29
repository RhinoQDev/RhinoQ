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
		ID: "task-public", Type: "report.export", DefinitionVersion: 1,
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
		polled.EntityVersion != queued.EntityVersion {
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
