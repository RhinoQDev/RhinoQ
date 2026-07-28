package operations

import (
	"context"
	"errors"
	"time"

	"github.com/madebyduy/RhinoQ/internal/domain/admission"
	"github.com/madebyduy/RhinoQ/internal/ports"
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

// SetAdmission installs producer backpressure: past this budget the queue stops
// accepting work instead of growing until the database is the outage.
func (q *QueueControl) SetAdmission(ctx context.Context, name string, policy admission.Policy) error {
	return q.store.SetQueueAdmission(ctx, name, policy)
}

func (q *QueueControl) RemoveAdmission(ctx context.Context, name string) error {
	return q.store.RemoveQueueAdmission(ctx, name)
}
