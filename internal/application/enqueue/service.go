package enqueue

import (
	"context"
	"errors"

	"github.com/rhinoq/rhinoq/internal/ports"
)

type Service struct {
	jobs ports.JobStore
}

func NewService(jobs ports.JobStore) *Service {
	return &Service{jobs: jobs}
}

func (s *Service) Execute(ctx context.Context, input ports.EnqueueInput) (ports.JobID, error) {
	if s == nil || s.jobs == nil {
		return "", errors.New("job store is required")
	}
	return s.jobs.Enqueue(ctx, input)
}
