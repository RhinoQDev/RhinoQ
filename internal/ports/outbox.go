package ports

import (
	"context"
	"time"
)

type OutboxEvent struct {
	ID            int64
	ClaimID       string
	AggregateType string
	AggregateID   string
	EventType     string
	Payload       []byte
}

// DefaultOutboxReclaimAfter is how long a claim may sit unresolved before
// another publisher may take it. A publisher that crashes between claiming and
// marking would otherwise strand its batch forever: the claim filter skips
// claimed rows, so nothing would ever look at them again.
const DefaultOutboxReclaimAfter = 5 * time.Minute

type OutboxStore interface {
	Append(ctx context.Context, event OutboxEvent) error
	// ClaimUnpublished takes a batch in one statement and also reclaims any
	// batch whose claim is older than reclaimAfter. Zero means
	// DefaultOutboxReclaimAfter.
	ClaimUnpublished(ctx context.Context, limit int, reclaimAfter time.Duration) ([]OutboxEvent, error)
	// MarkPublishedBatch settles a whole claimed batch in one statement and
	// returns how many rows it actually moved. A count below len(ids) means
	// another publisher reclaimed part of the batch.
	MarkPublishedBatch(ctx context.Context, claimID string, ids []int64) (int, error)
	// MarkFailedBatch releases a claim without publishing, so the events are
	// retried on the next sweep instead of waiting for the reclaim timeout.
	MarkFailedBatch(ctx context.Context, claimID string, ids []int64) (int, error)
}

type EventPublisher interface {
	Publish(ctx context.Context, event OutboxEvent) error
}
