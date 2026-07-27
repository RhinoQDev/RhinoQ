package unit

import (
	"context"
	"testing"
	"time"

	"github.com/rhinoq/rhinoq/internal/ports"
	"github.com/rhinoq/rhinoq/internal/runtime/scheduler"
)

type fakeOutbox struct {
	events    []ports.OutboxEvent
	published []int64
}

func (f *fakeOutbox) Append(context.Context, ports.OutboxEvent) error { return nil }
func (f *fakeOutbox) ClaimUnpublished(context.Context, int) ([]ports.OutboxEvent, error) {
	events := f.events
	f.events = nil
	return events, nil
}
func (f *fakeOutbox) MarkPublished(_ context.Context, id int64, _ string) error {
	f.published = append(f.published, id)
	return nil
}

type fakePublisher struct{ published []int64 }

func (f *fakePublisher) Publish(_ context.Context, event ports.OutboxEvent) error {
	f.published = append(f.published, event.ID)
	return nil
}

func TestOutboxPublisherPublishesAndMarks(t *testing.T) {
	store := &fakeOutbox{events: []ports.OutboxEvent{{ID: 7, ClaimID: "claim-1", EventType: "job.completed"}}}
	transport := &fakePublisher{}
	publisher, err := scheduler.NewOutboxPublisher(scheduler.PublisherConfig{Store: store, Publisher: transport, BatchSize: 10, Interval: time.Millisecond})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	go func() { time.Sleep(5 * time.Millisecond); cancel() }()
	if err := publisher.Run(ctx); err != context.Canceled {
		t.Fatalf("expected cancellation, got %v", err)
	}
	if len(transport.published) != 1 || len(store.published) != 1 {
		t.Fatalf("event was not fully published: transport=%v store=%v", transport.published, store.published)
	}
}
