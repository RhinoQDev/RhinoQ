package ports

import "context"

type OutboxEvent struct {
	ID            int64
	ClaimID       string
	AggregateType string
	AggregateID   string
	EventType     string
	Payload       []byte
}

type OutboxStore interface {
	Append(ctx context.Context, event OutboxEvent) error
	ClaimUnpublished(ctx context.Context, limit int) ([]OutboxEvent, error)
	MarkPublished(ctx context.Context, eventID int64, claimID string) error
}

type EventPublisher interface {
	Publish(ctx context.Context, event OutboxEvent) error
}
