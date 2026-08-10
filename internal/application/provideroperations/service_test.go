package provideroperations

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/madebyduy/RhinoQ/internal/adapters/memory"
	"github.com/madebyduy/RhinoQ/internal/domain/provideroperation"
)

func TestBeginRejectsRequestFingerprintReuse(t *testing.T) {
	store := memory.NewProviderOperationStore()
	now := time.Date(2026, 8, 5, 12, 0, 0, 0, time.UTC)
	service, err := New(store, func() time.Time { return now })
	if err != nil {
		t.Fatal(err)
	}
	first, err := service.BeginWithFingerprint(context.Background(), provideroperation.ID("op-1"), "task-1", "stripe", "refund", "refund-1", "hash-a", provideroperation.ConfirmReadback, provideroperation.RetryWhenAbsent)
	if err != nil {
		t.Fatal(err)
	}
	if first.RequestFingerprint != "hash-a" {
		t.Fatalf("fingerprint=%q", first.RequestFingerprint)
	}
	if _, err := service.BeginWithFingerprint(context.Background(), provideroperation.ID("op-2"), "task-1", "stripe", "refund", "refund-1", "hash-b", provideroperation.ConfirmReadback, provideroperation.RetryWhenAbsent); err == nil || !strings.Contains(err.Error(), "idempotency key") {
		t.Fatalf("different request shape must be rejected: %v", err)
	}
	if _, err := service.BeginWithFingerprint(context.Background(), provideroperation.ID("op-3"), "task-1", "stripe", "refund", "refund-1", "hash-a", provideroperation.ConfirmReadback, provideroperation.RetryWhenAbsent); err != nil {
		t.Fatalf("same request shape should resume: %v", err)
	}
}

func TestAttentionReturnsOnlyOldestUnresolvedOperations(t *testing.T) {
	store := memory.NewProviderOperationStore()
	now := time.Date(2026, 8, 9, 12, 0, 0, 0, time.UTC)
	service, _ := New(store, func() time.Time { return now })
	ctx := context.Background()
	old, err := service.Begin(ctx, "op-old", "task-1", "stripe", "refund", "refund-old", provideroperation.ConfirmReadback, provideroperation.RetryWhenAbsent)
	if err != nil {
		t.Fatal(err)
	}
	now = now.Add(time.Minute)
	confirmed, err := service.Begin(ctx, "op-done", "task-2", "stripe", "refund", "refund-done", provideroperation.ConfirmReadback, provideroperation.RetryWhenAbsent)
	if err != nil {
		t.Fatal(err)
	}
	confirmed, err = service.Accept(ctx, confirmed, "refund-1", "accepted")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = service.Confirm(ctx, confirmed, "provider readback"); err != nil {
		t.Fatal(err)
	}
	now = now.Add(time.Minute)
	if _, err = service.Begin(ctx, "op-new", "task-3", "storage", "upload", "upload-new", provideroperation.ConfirmReadback, provideroperation.RetryWhenAbsent); err != nil {
		t.Fatal(err)
	}
	items, err := service.Attention(ctx, old.UpdatedAt.Add(30*time.Second), 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(items) != 1 || items[0].ID != old.ID {
		t.Fatalf("attention=%+v", items)
	}
}
