package operations

import (
	"context"
	"errors"

	"github.com/madebyduy/RhinoQ/internal/domain/job"
	"github.com/madebyduy/RhinoQ/internal/ports"
)

type QueueInspection struct{ store ports.JobStore }

func NewQueueInspection(store ports.JobStore) (*QueueInspection, error) {
	if store == nil {
		return nil, errors.New("job store is required")
	}
	return &QueueInspection{store: store}, nil
}

func (q *QueueInspection) List(ctx context.Context, input ports.ListJobsInput) ([]job.Record, error) {
	return q.store.ListJobs(ctx, input)
}

func (q *QueueInspection) Counts(ctx context.Context, name string) (map[job.State]int64, error) {
	return q.store.JobCounts(ctx, name)
}
