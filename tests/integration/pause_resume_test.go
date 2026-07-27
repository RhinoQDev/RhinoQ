package integration

import (
	"context"
	"testing"
	"time"

	"github.com/rhinoq/rhinoq/internal/adapters/memory"
	"github.com/rhinoq/rhinoq/internal/application/operations"
	"github.com/rhinoq/rhinoq/internal/ports"
)

func TestPauseResumeQueueControlsClaim(t *testing.T) {
	now := time.Now().UTC()
	store := memory.NewJobStoreWithClock(func() time.Time { return now })
	control, err := operations.NewQueueControl(store)
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	if err := control.Pause(ctx, "email"); err != nil {
		t.Fatal(err)
	}
	if _, err := store.Enqueue(ctx, ports.EnqueueInput{Name: "email", Payload: []byte("{}")}); err != nil {
		t.Fatal(err)
	}
	claimed, err := store.Claim(ctx, ports.ClaimInput{Now: now, Limit: 1, LeaseDuration: time.Minute})
	if err != nil {
		t.Fatal(err)
	}
	if len(claimed) != 0 {
		t.Fatal("paused queue must not claim jobs")
	}
	if err := control.Resume(ctx, "email"); err != nil {
		t.Fatal(err)
	}
	claimed, err = store.Claim(ctx, ports.ClaimInput{Now: now, Limit: 1, LeaseDuration: time.Minute})
	if err != nil || len(claimed) != 1 {
		t.Fatalf("resumed queue should claim job: len=%d err=%v", len(claimed), err)
	}
}
