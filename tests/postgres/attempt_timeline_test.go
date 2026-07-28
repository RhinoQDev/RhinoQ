package postgres_test

import (
	"context"
	"testing"

	"github.com/madebyduy/RhinoQ/pkg/rhinoq"
)

func TestAttemptTimelinePersistsTerminalEvidence(t *testing.T) {
	client := newClient(t)
	id := enqueue(t, client, rhinoq.JobRequest{QueueName: "timeline", JobName: "timeline", Payload: []byte("{}")})
	leased := claimOne(t, client, "worker-a")
	if err := client.CompleteJob(context.Background(), leased.Lease); err != nil {
		t.Fatal(err)
	}
	events, err := client.AttemptTimeline(context.Background(), id, 0, 50)
	if err != nil {
		t.Fatal(err)
	}
	if len(events) != 2 || events[0].Kind != "claimed" || events[1].Kind != "succeeded" {
		t.Fatalf("unexpected timeline: %+v", events)
	}
	if events[0].LeaseEpoch != events[1].LeaseEpoch {
		t.Fatalf("terminal evidence must belong to the claimed epoch: %+v", events)
	}
}
