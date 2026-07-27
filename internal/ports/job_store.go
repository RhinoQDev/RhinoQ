package ports

import (
	"context"
	"time"

	"github.com/rhinoq/rhinoq/internal/domain/job"
)

type JobID = job.ID

type EnqueueInput struct {
	Name           string
	Payload        []byte
	IdempotencyKey string
	NotBefore      time.Time
	CorrelationID  string
}

type ClaimInput struct {
	Now           time.Time
	Limit         int
	LeaseDuration time.Duration
}

type Lease struct {
	JobID     JobID
	LeaseID   string
	ExpiresAt time.Time
}

type FailureTransition struct {
	State     job.State
	NotBefore time.Time
}

type JobStore interface {
	Enqueue(ctx context.Context, input EnqueueInput) (JobID, error)
	Get(ctx context.Context, id JobID) (job.Record, bool, error)
	Claim(ctx context.Context, input ClaimInput) ([]job.Record, error)
	RenewLease(ctx context.Context, lease Lease, now time.Time, extension time.Duration) error
	Complete(ctx context.Context, lease Lease, now time.Time) error
	Fail(ctx context.Context, lease Lease, now time.Time, transition FailureTransition) error
	RequeueExpired(ctx context.Context, now time.Time) (int, error)
}
