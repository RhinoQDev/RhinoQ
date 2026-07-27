package scheduler

import (
	"context"
	"errors"
	"time"

	"github.com/rhinoq/rhinoq/internal/ports"
)

type OutboxPublisher struct {
	store     ports.OutboxStore
	publisher ports.EventPublisher
	batchSize int
	interval  time.Duration
}

type PublisherConfig struct {
	Store     ports.OutboxStore
	Publisher ports.EventPublisher
	BatchSize int
	Interval  time.Duration
}

func NewOutboxPublisher(config PublisherConfig) (*OutboxPublisher, error) {
	if config.Store == nil || config.Publisher == nil || config.BatchSize <= 0 || config.Interval <= 0 {
		return nil, errors.New("outbox publisher dependencies and positive limits are required")
	}
	return &OutboxPublisher{store: config.Store, publisher: config.Publisher, batchSize: config.BatchSize, interval: config.Interval}, nil
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

func (p *OutboxPublisher) publishBatch(ctx context.Context) error {
	events, err := p.store.ClaimUnpublished(ctx, p.batchSize)
	if err != nil {
		return err
	}
	for _, event := range events {
		if err := p.publisher.Publish(ctx, event); err != nil {
			return err
		}
		if err := p.store.MarkPublished(ctx, event.ID, event.ClaimID); err != nil {
			return err
		}
	}
	return nil
}
