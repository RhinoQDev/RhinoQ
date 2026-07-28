package enqueue

import (
	"context"
	"errors"

	"github.com/madebyduy/RhinoQ/internal/domain/job"
	"github.com/madebyduy/RhinoQ/internal/ports"
)

type Service struct {
	jobs            ports.JobStore
	maxPayloadBytes int
}

func NewService(jobs ports.JobStore) *Service {
	return NewServiceWithLimit(jobs, job.DefaultMaxPayloadBytes)
}

func NewServiceWithLimit(jobs ports.JobStore, maxPayloadBytes int) *Service {
	return &Service{jobs: jobs, maxPayloadBytes: maxPayloadBytes}
}

func (s *Service) Execute(ctx context.Context, input ports.EnqueueInput) (ports.JobID, error) {
	if s == nil || s.jobs == nil {
		return "", errors.New("job store is required")
	}
	if err := job.ValidatePayload(input.Payload, s.maxPayloadBytes); err != nil {
		return "", err
	}
	return s.jobs.Enqueue(ctx, input)
}
