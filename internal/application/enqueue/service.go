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

// ExecuteBatch validates the complete request before asking the store for one
// atomic commit. It never falls back to a client-side loop: partial dispatch is
// materially different from batch dispatch and must stay explicit.
func (s *Service) ExecuteBatch(ctx context.Context, inputs []ports.EnqueueInput) ([]ports.JobID, error) {
	if s == nil || s.jobs == nil {
		return nil, errors.New("job store is required")
	}
	if len(inputs) == 0 {
		return nil, errors.New("enqueue batch must contain at least one job")
	}
	if len(inputs) > ports.MaxEnqueueBatch {
		return nil, errors.New("enqueue batch exceeds 1000 jobs")
	}
	for _, input := range inputs {
		if err := job.ValidatePayload(input.Payload, s.maxPayloadBytes); err != nil {
			return nil, err
		}
	}
	store, ok := s.jobs.(ports.BatchJobStore)
	if !ok {
		return nil, errors.New("job store does not support atomic batch enqueue")
	}
	return store.EnqueueBatch(ctx, inputs)
}
