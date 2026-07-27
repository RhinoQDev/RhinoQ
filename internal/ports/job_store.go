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

type QueueRateLimit struct {
	Max    int
	Window time.Duration
}

type ListJobsInput struct {
	Name   string
	States []job.State
	Offset int
	Limit  int
}

type JobStore interface {
	Enqueue(ctx context.Context, input EnqueueInput) (JobID, error)
	Get(ctx context.Context, id JobID) (job.Record, bool, error)
	ListJobs(ctx context.Context, input ListJobsInput) ([]job.Record, error)
	JobCounts(ctx context.Context, name string) (map[job.State]int64, error)
	Claim(ctx context.Context, input ClaimInput) ([]job.Record, error)
	RenewLease(ctx context.Context, lease Lease, now time.Time, extension time.Duration) error
	Complete(ctx context.Context, lease Lease, now time.Time) error
	Fail(ctx context.Context, lease Lease, now time.Time, transition FailureTransition) error
	RequestCancel(ctx context.Context, id JobID) error
	IsCancelRequested(ctx context.Context, id JobID) (bool, error)
	RequeueExpired(ctx context.Context, now time.Time) (int, error)
	PauseQueue(ctx context.Context, name string) error
	ResumeQueue(ctx context.Context, name string) error
	SetQueueRateLimit(ctx context.Context, name string, limit QueueRateLimit) error
	RemoveQueueRateLimit(ctx context.Context, name string) error
	QueueRateLimitTTL(ctx context.Context, name string, now time.Time) (time.Duration, error)
}
