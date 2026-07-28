package integration

import (
	"context"
	"testing"
	"time"

	"github.com/rhinoq/rhinoq/pkg/rhinoq"
)

func TestAttemptTimelineIsAppendOnlyAcrossReleaseAndCompletion(t *testing.T) {
	ctx := context.Background()
	client := rhinoq.NewInMemory()
	id, err := client.Enqueue(ctx, rhinoq.JobRequest{Name: "render-report", Payload: []byte("{}")})
	if err != nil {
		t.Fatal(err)
	}

	first, err := client.ClaimJobs(ctx, rhinoq.ClaimRequest{
		Worker: "worker-a", Limit: 1, LeaseFor: time.Minute,
	})
	if err != nil || len(first) != 1 {
		t.Fatalf("first claim: jobs=%d err=%v", len(first), err)
	}
	if err := client.ReleaseJob(ctx, first[0].Lease); err != nil {
		t.Fatal(err)
	}

	second, err := client.ClaimJobs(ctx, rhinoq.ClaimRequest{
		Worker: "worker-b", Limit: 1, LeaseFor: time.Minute,
	})
	if err != nil || len(second) != 1 {
		t.Fatalf("second claim: jobs=%d err=%v", len(second), err)
	}
	if err := client.CompleteJob(ctx, second[0].Lease); err != nil {
		t.Fatal(err)
	}

	events, err := client.AttemptTimeline(ctx, id, 0, 50)
	if err != nil {
		t.Fatal(err)
	}
	kinds := []string{"claimed", "released", "claimed", "succeeded"}
	if len(events) != len(kinds) {
		t.Fatalf("expected %d events, got %+v", len(kinds), events)
	}
	for index, kind := range kinds {
		if events[index].Kind != kind {
			t.Fatalf("event %d: want %s, got %+v", index, kind, events[index])
		}
		if events[index].Sequence != int64(index+1) {
			t.Fatalf("event %d has unstable sequence: %+v", index, events[index])
		}
	}
	if events[0].Attempt != 1 || events[2].Attempt != 1 {
		t.Fatalf("a released reservation must give the numeric attempt back: %+v", events)
	}
	if events[0].LeaseEpoch == events[2].LeaseEpoch {
		t.Fatalf("lease epoch must still distinguish the two reservations: %+v", events)
	}
}

func TestAttemptTimelineRecordsFailureClassification(t *testing.T) {
	ctx := context.Background()
	client := rhinoq.NewInMemory()
	id, err := client.Enqueue(ctx, rhinoq.JobRequest{Name: "sync-account", Payload: []byte("{}")})
	if err != nil {
		t.Fatal(err)
	}
	claimed, err := client.ClaimJobs(ctx, rhinoq.ClaimRequest{
		Worker: "worker-a", Limit: 1, LeaseFor: time.Minute,
	})
	if err != nil || len(claimed) != 1 {
		t.Fatalf("claim: jobs=%d err=%v", len(claimed), err)
	}
	if _, err := client.FailJob(ctx, claimed[0].Lease, rhinoq.FailureReport{
		Type: "TimeoutError", RetryClass: rhinoq.RetryDependencyDown,
		Message: "provider unavailable",
	}); err != nil {
		t.Fatal(err)
	}
	events, err := client.AttemptTimeline(ctx, id, 0, 50)
	if err != nil {
		t.Fatal(err)
	}
	if len(events) != 2 || events[1].Kind != "retry_scheduled" ||
		events[1].FailureClass != rhinoq.RetryDependencyDown {
		t.Fatalf("failure evidence is incomplete: %+v", events)
	}
}
