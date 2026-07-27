package execution

import (
	"context"
	"errors"
	"time"

	"github.com/rhinoq/rhinoq/internal/domain/job"
	"github.com/rhinoq/rhinoq/internal/ports"
)

var ErrInvalidClaimInput = errors.New("claim limit and lease duration must be positive")

type ClaimJobs struct {
	jobs ports.JobStore
}

func NewClaimJobs(jobs ports.JobStore) *ClaimJobs {
	return &ClaimJobs{jobs: jobs}
}

func (c *ClaimJobs) Execute(ctx context.Context, now time.Time, limit int, leaseDuration time.Duration) ([]job.Record, error) {
	if c == nil || c.jobs == nil || limit <= 0 || leaseDuration <= 0 {
		return nil, ErrInvalidClaimInput
	}
	return c.jobs.Claim(ctx, ports.ClaimInput{Now: now, Limit: limit, LeaseDuration: leaseDuration})
}
