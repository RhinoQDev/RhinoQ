package scheduler

import (
	"context"
	"errors"
	"time"

	"github.com/madebyduy/RhinoQ/internal/ports"
)

type OutboxPublisher struct {
	store        ports.OutboxStore
	publisher    ports.EventPublisher
	batchSize    int
	interval     time.Duration
	reclaimAfter time.Duration
}

type PublisherConfig struct {
	Store     ports.OutboxStore
	Publisher ports.EventPublisher
	BatchSize int
	Interval  time.Duration
	// ReclaimAfter is how long a claim may sit unresolved before another
	// publisher may take it, covering a process that died mid-batch. Defaults to
	// ports.DefaultOutboxReclaimAfter.
	ReclaimAfter time.Duration
}

func NewOutboxPublisher(config PublisherConfig) (*OutboxPublisher, error) {
	if config.Store == nil || config.Publisher == nil || config.BatchSize <= 0 || config.Interval <= 0 {
		return nil, errors.New("outbox publisher dependencies and positive limits are required")
	}
	reclaim := config.ReclaimAfter
	if reclaim <= 0 {
		reclaim = ports.DefaultOutboxReclaimAfter
	}
	return &OutboxPublisher{
		store: config.Store, publisher: config.Publisher,
		batchSize: config.BatchSize, interval: config.Interval,
		reclaimAfter: reclaim,
	}, nil
}

func (p *OutboxPublisher) Run(ctx context.Context) error {
	if ctx == nil {
		return errors.New("publisher context is required")
	}
	ticker := time.NewTicker(p.interval)
	defer ticker.Stop()
	for {
		if err := p.publishBatch(ctx); err != nil {
			return err
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-ticker.C:
		}
	}
}

// publishBatch claims a batch, publishes it in order, and settles the whole
// batch in one statement.
//
// Marking each event separately cost one round trip per event and, worse, left
// no way to release a claim: a failed publish returned immediately and the rest
// of the batch stayed claimed with nothing ever looking at it again. Now
// everything published before the failure is marked, everything after it is
// released, and the next sweep retries exactly the unpublished remainder.
//
// Publishing stays sequential and in id order. An aggregate's events are only
// meaningful in the order they were appended, so the batching here is in the
// settle, not in the transport.
func (p *OutboxPublisher) publishBatch(ctx context.Context) error {
	events, err := p.store.ClaimUnpublished(ctx, p.batchSize, p.reclaimAfter)
	if err != nil {
		return err
	}
	if len(events) == 0 {
		return nil
	}
	claimID := events[0].ClaimID

	published := make([]int64, 0, len(events))
	var publishErr error
	for _, event := range events {
		if err := p.publisher.Publish(ctx, event); err != nil {
			publishErr = err
			break
		}
		published = append(published, event.ID)
	}

	if len(published) > 0 {
		if _, err := p.store.MarkPublishedBatch(ctx, claimID, published); err != nil {
			// The transport already delivered these. Reporting the store error
			// is right, but do not release them: a later reclaim will retry, and
			// consumers must be idempotent for that reason.
			return err
		}
	}
	if publishErr == nil {
		return nil
	}

	unpublished := make([]int64, 0, len(events)-len(published))
	for _, event := range events[len(published):] {
		unpublished = append(unpublished, event.ID)
	}
	if _, err := p.store.MarkFailedBatch(ctx, claimID, unpublished); err != nil {
		return errors.Join(publishErr, err)
	}
	return publishErr
}
