package integration

import (
	"context"
	"testing"

	"github.com/madebyduy/RhinoQ/internal/adapters/memory"
	"github.com/madebyduy/RhinoQ/internal/application/enqueue"
	"github.com/madebyduy/RhinoQ/internal/ports"
)

func TestEnqueueIsIdempotentWithinNameScope(t *testing.T) {
	store := memory.NewJobStore()
	service := enqueue.NewService(store)
	input := ports.EnqueueInput{Name: "send-email", Payload: []byte(`{"userId":"u1"}`), IdempotencyKey: "user:u1"}

	first, err := service.Execute(context.Background(), input)
	if err != nil {
		t.Fatal(err)
	}
	second, err := service.Execute(context.Background(), input)
	if err != nil {
		t.Fatal(err)
	}
	if first != second {
		t.Fatalf("expected duplicate enqueue to return %q, got %q", first, second)
	}

	record, ok, err := store.Get(context.Background(), first)
	if err != nil || !ok {
		t.Fatalf("expected stored job, ok=%v err=%v", ok, err)
	}
	if record.State.String() != "pending" {
		t.Fatalf("expected pending state, got %s", record.State)
	}
}
