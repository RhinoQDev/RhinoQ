package integration

import (
	"context"
	"testing"
	"time"

	"github.com/rhinoq/rhinoq/internal/adapters/memory"
	"github.com/rhinoq/rhinoq/internal/application/operations"
	"github.com/rhinoq/rhinoq/internal/domain/job"
	"github.com/rhinoq/rhinoq/internal/ports"
)

func TestQueueInspectionCountsFiltersAndPaginates(t *testing.T) {
	now := time.Date(2026, 7, 27, 12, 0, 0, 0, time.UTC)
	store := memory.NewJobStoreWithClock(func() time.Time { return now })
	ctx := context.Background()
	for _, name := range []string{"email", "email", "media"} {
		if _, err := store.Enqueue(ctx, ports.EnqueueInput{Name: name, Payload: []byte("{}")}); err != nil {
			t.Fatal(err)
		}
	}
	claimed, err := store.Claim(ctx, ports.ClaimInput{Owner: "worker-1", Now: now, Limit: 1, LeaseDuration: time.Minute})
	if err != nil || len(claimed) != 1 {
		t.Fatalf("claim fixture: len=%d err=%v", len(claimed), err)
	}
	if err := store.Complete(ctx, ports.LeaseFor(claimed[0]), now); err != nil {
		t.Fatal(err)
	}

	inspection, err := operations.NewQueueInspection(store)
	if err != nil {
		t.Fatal(err)
	}
	counts, err := inspection.Counts(ctx, "email")
	if err != nil {
		t.Fatal(err)
	}
	if counts[job.Succeeded] != 1 || counts[job.Pending] != 1 {
		t.Fatalf("unexpected email counts: %+v", counts)
	}
	page, err := inspection.List(ctx, ports.ListJobsInput{
		Name: "email", States: []job.State{job.Pending}, Limit: 1,
	})
	if err != nil || len(page) != 1 || page[0].State != job.Pending {
		t.Fatalf("unexpected filtered page: %+v err=%v", page, err)
	}
	empty, err := inspection.List(ctx, ports.ListJobsInput{Name: "email", Offset: 2, Limit: 1})
	if err != nil || len(empty) != 0 {
		t.Fatalf("offset beyond result must return empty page: %+v err=%v", empty, err)
	}
}
