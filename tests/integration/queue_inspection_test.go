package integration

import (
	"context"
	"testing"
	"time"

	"github.com/madebyduy/RhinoQ/internal/adapters/memory"
	"github.com/madebyduy/RhinoQ/internal/application/operations"
	"github.com/madebyduy/RhinoQ/internal/domain/job"
	"github.com/madebyduy/RhinoQ/internal/ports"
)

func TestQueueInspectionCountsFiltersAndPaginates(t *testing.T) {
	now := time.Date(2026, 7, 27, 12, 0, 0, 0, time.UTC)
	store := memory.NewJobStoreWithClock(func() time.Time { return now })
	ctx := context.Background()
	for _, name := range []string{"email", "email", "media"} {
		if _, err := store.Enqueue(ctx, ports.EnqueueInput{Identity: job.Identity{QueueName: name, JobName: name}, Payload: []byte("{}")}); err != nil {
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
		QueueName: "email", States: []job.State{job.Pending}, Limit: 1,
	})
	if err != nil || len(page) != 1 || page[0].State != job.Pending {
		t.Fatalf("unexpected filtered page: %+v err=%v", page, err)
	}
	empty, err := inspection.List(ctx, ports.ListJobsInput{QueueName: "email", Offset: 2, Limit: 1})
	if err != nil || len(empty) != 0 {
		t.Fatalf("offset beyond result must return empty page: %+v err=%v", empty, err)
	}
}
