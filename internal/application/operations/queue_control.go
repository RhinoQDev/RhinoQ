package operations

import (
	"context"
	"errors"
	"time"

	"github.com/rhinoq/rhinoq/internal/ports"
)

type QueueControl struct{ store ports.JobStore }

func NewQueueControl(store ports.JobStore) (*QueueControl, error) {
	if store == nil {
		return nil, errors.New("job store is required")
	}
	return &QueueControl{store: store}, nil
}

func (q *QueueControl) Pause(ctx context.Context, name string) error {
	return q.store.PauseQueue(ctx, name)
}
func (q *QueueControl) Resume(ctx context.Context, name string) error {
	return q.store.ResumeQueue(ctx, name)
}

func (q *QueueControl) SetRateLimit(ctx context.Context, name string, max int, window time.Duration) error {
	return q.store.SetQueueRateLimit(ctx, name, ports.QueueRateLimit{Max: max, Window: window})
}

func (q *QueueControl) RemoveRateLimit(ctx context.Context, name string) error {
	return q.store.RemoveQueueRateLimit(ctx, name)
}

func (q *QueueControl) RateLimitTTL(ctx context.Context, name string, now time.Time) (time.Duration, error) {
	return q.store.QueueRateLimitTTL(ctx, name, now)
}
