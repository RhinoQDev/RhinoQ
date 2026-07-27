package operations

import (
	"context"
	"errors"

	"github.com/rhinoq/rhinoq/internal/ports"
)

type JobCancellation struct{ store ports.JobStore }

func NewJobCancellation(store ports.JobStore) (*JobCancellation, error) {
	if store == nil {
		return nil, errors.New("job store is required")
	}
	return &JobCancellation{store: store}, nil
}

func (c *JobCancellation) Cancel(ctx context.Context, id ports.JobID) error {
	if id == "" {
		return errors.New("job id is required")
	}
	return c.store.RequestCancel(ctx, id)
}
