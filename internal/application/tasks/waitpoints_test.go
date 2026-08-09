package tasks

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/madebyduy/RhinoQ/internal/adapters/memory"
	"github.com/madebyduy/RhinoQ/internal/domain/task"
	"github.com/madebyduy/RhinoQ/internal/domain/waitpoint"
	"github.com/madebyduy/RhinoQ/internal/ports"
)

func TestWaitpointOwnerIsolationAndIdempotentResolution(t *testing.T) {
	ctx := context.Background()
	now := time.Date(2026, 8, 9, 1, 0, 0, 0, time.UTC)
	store := memory.NewTaskStore()
	service, err := New(store, store, func() time.Time { return now })
	if err != nil {
		t.Fatal(err)
	}
	if _, err = service.Create(ctx, CreateInput{ID: task.ID("task-1"), Type: "report", OwnerID: "owner-1", DefinitionVersion: 1}); err != nil {
		t.Fatal(err)
	}
	created, replayed, err := service.CreateWaitpoint(ctx, CreateWaitpointInput{ID: "wp-1", TaskID: "task-1", Key: "approve", Kind: waitpoint.Approval, SchemaVersion: 1, Deadline: now.Add(time.Hour)})
	if err != nil || replayed {
		t.Fatalf("create: %#v %v %v", created, replayed, err)
	}
	if _, err = service.GetWaitpoint(ctx, "wp-1", "other-owner"); !errors.Is(err, ports.ErrWaitpointNotFound) {
		t.Fatalf("owner leak: %v", err)
	}
	now = now.Add(time.Minute)
	input := ResolveWaitpointInput{ID: "wp-1", OwnerID: "owner-1", ResolutionID: "submit-1", Actor: "owner-1", ExpectedVersion: created.Version, Resolution: []byte(`{"approved":true}`)}
	resolved, err := service.ResolveWaitpoint(ctx, input)
	if err != nil {
		t.Fatal(err)
	}
	replayedResult, err := service.ResolveWaitpoint(ctx, input)
	if err != nil || replayedResult.Version != resolved.Version {
		t.Fatalf("replay: %#v %v", replayedResult, err)
	}
	input.Resolution = []byte(`{"approved":false}`)
	if _, err = service.ResolveWaitpoint(ctx, input); !errors.Is(err, waitpoint.ErrResolutionConflict) {
		t.Fatalf("conflict: %v", err)
	}
}

func TestExpireDueWaitpointsIsBounded(t *testing.T) {
	ctx := context.Background()
	now := time.Date(2026, 8, 9, 1, 0, 0, 0, time.UTC)
	store := memory.NewTaskStore()
	service, _ := New(store, store, func() time.Time { return now })
	_, _ = service.Create(ctx, CreateInput{ID: "task-1", Type: "report", OwnerID: "owner", DefinitionVersion: 1})
	_, _, _ = service.CreateWaitpoint(ctx, CreateWaitpointInput{ID: "wp-1", TaskID: "task-1", Key: "one", Kind: waitpoint.Input, SchemaVersion: 1, Deadline: now.Add(time.Minute)})
	_, _, _ = service.CreateWaitpoint(ctx, CreateWaitpointInput{ID: "wp-2", TaskID: "task-1", Key: "two", Kind: waitpoint.Input, SchemaVersion: 1, Deadline: now.Add(time.Minute)})
	now = now.Add(time.Minute)
	count, err := service.ExpireDueWaitpoints(ctx, 1)
	if err != nil || count != 1 {
		t.Fatalf("expire count=%d err=%v", count, err)
	}
}
