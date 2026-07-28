package unit

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/madebyduy/RhinoQ/internal/ports"
	"github.com/madebyduy/RhinoQ/internal/runtime/scheduler"
)

// fakeOutbox records how many statements the publisher issues, because the
// point of the batch API is the statement count, not just the end state.
type fakeOutbox struct {
	events    []ports.OutboxEvent
	published []int64
	released  []int64
	claims    int
	settles   int
}

func (f *fakeOutbox) Append(context.Context, ports.OutboxEvent) error { return nil }

func (f *fakeOutbox) ClaimUnpublished(_ context.Context, _ int, _ time.Duration) ([]ports.OutboxEvent, error) {
	f.claims++
	events := f.events
	f.events = nil
	return events, nil
}

func (f *fakeOutbox) MarkPublishedBatch(_ context.Context, _ string, ids []int64) (int, error) {
	f.settles++
	f.published = append(f.published, ids...)
	return len(ids), nil
}

func (f *fakeOutbox) MarkFailedBatch(_ context.Context, _ string, ids []int64) (int, error) {
	f.settles++
	f.released = append(f.released, ids...)
	return len(ids), nil
}

type fakePublisher struct {
	published []int64
	failOn    int64
}

func (f *fakePublisher) Publish(_ context.Context, event ports.OutboxEvent) error {
	if f.failOn != 0 && event.ID == f.failOn {
		return errors.New("transport refused the event")
	}
	f.published = append(f.published, event.ID)
	return nil
}

func batchOf(ids ...int64) []ports.OutboxEvent {
	events := make([]ports.OutboxEvent, 0, len(ids))
	for _, id := range ids {
		events = append(events, ports.OutboxEvent{ID: id, ClaimID: "claim-1", EventType: "job.completed"})
	}
	return events
}

// runOnce drives the publisher until it is cancelled or stops on an error, and
// returns whatever it stopped on. A transport failure still propagates: the
// supervisor decides whether to restart, and the release path exists so the
// unpublished remainder is retryable the moment it does.
func runOnce(t *testing.T, store ports.OutboxStore, transport ports.EventPublisher) error {
	t.Helper()
	publisher, err := scheduler.NewOutboxPublisher(scheduler.PublisherConfig{
		Store: store, Publisher: transport, BatchSize: 10, Interval: time.Millisecond,
	})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	go func() { time.Sleep(5 * time.Millisecond); cancel() }()
	stopped := publisher.Run(ctx)
	if errors.Is(stopped, context.Canceled) {
		return nil
	}
	return stopped
}

// A batch must settle in one statement, not one per event.
func TestOutboxPublisherSettlesAWholeBatchInOneStatement(t *testing.T) {
	store := &fakeOutbox{events: batchOf(7, 8, 9)}
	transport := &fakePublisher{}

	if err := runOnce(t, store, transport); err != nil {
		t.Fatalf("publisher stopped unexpectedly: %v", err)
	}

	if len(transport.published) != 3 {
		t.Fatalf("every event must reach the transport, got %v", transport.published)
	}
	if len(store.published) != 3 {
		t.Fatalf("every event must be marked published, got %v", store.published)
	}
	if store.settles != 1 {
		t.Fatalf("three events must settle in one statement, got %d", store.settles)
	}
}

// A transport failure used to strand the rest of the batch: the events stayed
// claimed, and the claim filter meant nothing ever looked at them again.
func TestOutboxPublisherReleasesTheRemainderAfterAFailedPublish(t *testing.T) {
	store := &fakeOutbox{events: batchOf(1, 2, 3, 4)}
	transport := &fakePublisher{failOn: 3}

	// The transport error still surfaces; what changed is that the batch is no
	// longer left claimed behind it.
	if err := runOnce(t, store, transport); err == nil {
		t.Fatal("a transport failure must be reported, not swallowed")
	}

	if len(transport.published) != 2 {
		t.Fatalf("publishing must stop at the failure, got %v", transport.published)
	}
	if len(store.published) != 2 || store.published[0] != 1 || store.published[1] != 2 {
		t.Fatalf("only the delivered prefix may be marked published, got %v", store.published)
	}
	if len(store.released) != 2 || store.released[0] != 3 || store.released[1] != 4 {
		t.Fatalf("the undelivered remainder must be released for retry, got %v", store.released)
	}
}

// An empty outbox must not issue a settle statement at all.
func TestOutboxPublisherDoesNotSettleAnEmptyBatch(t *testing.T) {
	store := &fakeOutbox{}
	transport := &fakePublisher{}

	if err := runOnce(t, store, transport); err != nil {
		t.Fatalf("publisher stopped unexpectedly: %v", err)
	}

	if store.claims == 0 {
		t.Fatal("the publisher must still poll an empty outbox")
	}
	if store.settles != 0 {
		t.Fatalf("an empty batch must not settle anything, got %d statements", store.settles)
	}
}
