package operations

import (
	"context"
	"errors"

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
