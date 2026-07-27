package unit

import (
	"context"
	"testing"

	"github.com/rhinoq/rhinoq/pkg/rhinoq"
)

func TestPublicClientUsesStoreBoundary(t *testing.T) {
	client := rhinoq.NewInMemory()
	if err := client.Handle("demo", func(context.Context, rhinoq.Job) error { return nil }); err != nil {
		t.Fatal(err)
	}
	id, err := client.Enqueue(context.Background(), "demo", []byte("{}"), "demo:1")
	if err != nil || id == "" {
		t.Fatalf("expected public enqueue, id=%q err=%v", id, err)
	}
}
