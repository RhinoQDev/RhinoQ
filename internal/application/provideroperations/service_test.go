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
