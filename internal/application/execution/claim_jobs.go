package execution

import (
	"context"
	"errors"
	"time"

	"github.com/madebyduy/RhinoQ/internal/domain/job"
	"github.com/madebyduy/RhinoQ/internal/ports"
)

var ErrInvalidClaimInput = errors.New("claim owner is required and claim limit and lease duration must be positive")

type ClaimJobs struct {
	jobs ports.JobStore
}

func NewClaimJobs(jobs ports.JobStore) *ClaimJobs {
	return &ClaimJobs{jobs: jobs}
}

// Execute leases a batch of jobs for owner. The owner is part of the fencing
// token every later operation must present, so it cannot be omitted.
func (c *ClaimJobs) Execute(ctx context.Context, owner string, now time.Time, limit int, leaseDuration time.Duration) ([]job.Record, error) {
	if c == nil || c.jobs == nil || owner == "" || limit <= 0 || leaseDuration <= 0 {
		return nil, ErrInvalidClaimInput
	}
	return c.jobs.Claim(ctx, ports.ClaimInput{Owner: owner, Now: now, Limit: limit, LeaseDuration: leaseDuration})
}
