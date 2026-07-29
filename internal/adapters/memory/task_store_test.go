package memory

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/madebyduy/RhinoQ/internal/domain/execution"
	"github.com/madebyduy/RhinoQ/internal/domain/task"
	"github.com/madebyduy/RhinoQ/internal/ports"
)

func TestTaskStoreEnforcesVersionsAndAttemptUniqueness(t *testing.T) {
	ctx := context.Background()
	now := time.Date(2026, 7, 29, 12, 0, 0, 0, time.UTC)
	store := NewTaskStore()
	record, err := task.NewRecord(task.Spec{ID: "task-1", Type: "export", DefinitionVersion: 1, Now: now})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.CreateTask(ctx, record); err != nil {
		t.Fatal(err)
	}
	queued, err := record.Transition(task.Queued, now.Add(time.Second))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.UpdateTask(ctx, queued, record.Version); err != nil {
		t.Fatal(err)
	}
	if _, err := store.UpdateTask(ctx, queued, record.Version); !errors.Is(err, ports.ErrVersionConflict) {
		t.Fatalf("expected optimistic version conflict, got %v", err)
	}

	first, firstVersion, err := store.CreateNextExecution(ctx, ports.ExecutionCreateInput{
		ID: "exec-1", TaskID: "task-1", Runtime: execution.RuntimeNative, Now: now,
	})
	if err != nil {
		t.Fatal(err)
	}
	second, secondVersion, err := store.CreateNextExecution(ctx, ports.ExecutionCreateInput{
		ID: "exec-2", TaskID: "task-1", Runtime: "bullmq", Now: now,
	})
	if err != nil {
		t.Fatal(err)
	}
	if first.Attempt != 1 || second.Attempt != 2 {
		t.Fatalf("store must allocate attempts atomically: first=%d second=%d", first.Attempt, second.Attempt)
	}
	if firstVersion != queued.Version+1 || secondVersion != firstVersion+1 {
		t.Fatalf("execution writes must advance task version: first=%d second=%d", firstVersion, secondVersion)
	}
	if _, _, err := store.CreateNextExecution(ctx, ports.ExecutionCreateInput{
		ID: "exec-2", TaskID: "task-1", Runtime: "bullmq", Now: now,
	}); !errors.Is(err, ports.ErrAlreadyExists) {
		t.Fatalf("expected duplicate execution rejection, got %v", err)
	}
}
