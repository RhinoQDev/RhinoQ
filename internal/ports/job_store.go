package ports

import (
	"context"
	"time"

	"github.com/rhinoq/rhinoq/internal/domain/admission"
	"github.com/rhinoq/rhinoq/internal/domain/job"
)

type JobID = job.ID

type EnqueueInput struct {
	Name           string
	Payload        []byte
	IdempotencyKey string
	NotBefore      time.Time
	CorrelationID  string
	// Priority orders claiming inside a queue; higher runs first. Waiting jobs
	// age upwards so a low priority job cannot starve (domain/job scheduling).
	Priority int
	// Class decides which admission budget the job draws from.
	Class job.Class
}

type ClaimInput struct {
	// Owner identifies the claiming worker. It is stored as the lease owner and
	// must be presented, together with the epoch, by every later operation.
	Owner         string
	Now           time.Time
	Limit         int
	LeaseDuration time.Duration
}

// Lease is the fencing token for one execution of one job. Owner alone is not
// enough: a worker that lost its lease and came back would still match. Epoch
// increases on every claim, so a stale execution can be told apart from the
// current one (specification 41.3).
type Lease struct {
	JobID     JobID
	Owner     string
	Epoch     int64
	ExpiresAt time.Time
}

// LeaseFor builds the fencing token a worker holds for a freshly claimed job.
func LeaseFor(record job.Record) Lease {
	return Lease{
		JobID:     record.ID,
		Owner:     record.LeaseOwner,
		Epoch:     record.LeaseEpoch,
		ExpiresAt: record.LeaseUntil,
	}
}

func (l Lease) Valid() bool {
	return l.JobID != "" && l.Owner != "" && l.Epoch > 0
}

// LeaseStatus is what a heartbeat learns in a single round trip: the extended
// deadline, and whether an operator asked this execution to stop.
type LeaseStatus struct {
	ExpiresAt       time.Time
	CancelRequested bool
}

// FailureTransition is where a failed execution parks the job. RetryIn is a
// delay rather than an absolute instant so the store, not the worker's clock,
// decides when the job becomes eligible again (specification 50.3).
type FailureTransition struct {
	State         job.State
	RetryIn       time.Duration
	BlockedReason job.BlockedReason
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

// ReapInput drives one sweep over expired leases.
type ReapInput struct {
	Now        time.Time
	Protection job.Protection
}

// ExpiredLease identifies an execution that died. The epoch is what makes the
// clean-up safe: only work opened at or before this epoch belonged to the dead
// execution.
type ExpiredLease struct {
	JobID JobID
	Epoch int64
}

// ReapResult reports what a sweep did. Blocked jobs crashed their worker often
// enough to be parked instead of handed to the next one.
type ReapResult struct {
	Requeued int
	Blocked  int
	// Expired lists the executions that lost their lease in this sweep, so the
	// effect ledger can be cleaned up after them.
	Expired []ExpiredLease
}

// LeaseFence is the subset of JobStore that other stores need in order to
// refuse writes from an execution that already lost its job.
type LeaseFence interface {
	CheckLease(ctx context.Context, lease Lease, now time.Time) error
}

type JobStore interface {
	Enqueue(ctx context.Context, input EnqueueInput) (JobID, error)
	Get(ctx context.Context, id JobID) (job.Record, bool, error)
	ListJobs(ctx context.Context, input ListJobsInput) ([]job.Record, error)
	JobCounts(ctx context.Context, name string) (map[job.State]int64, error)
	Claim(ctx context.Context, input ClaimInput) ([]job.Record, error)
	RenewLease(ctx context.Context, lease Lease, now time.Time, extension time.Duration) (LeaseStatus, error)
	Complete(ctx context.Context, lease Lease, now time.Time) error
	// ReleaseLease returns a claimed job that was never executed - work a
	// stopping worker had prefetched. The attempt is given back too, because it
	// never happened.
	ReleaseLease(ctx context.Context, lease Lease, now time.Time) error
	Fail(ctx context.Context, lease Lease, now time.Time, transition FailureTransition) error
	// CheckLease reports whether a fencing token still authorises work. It is
	// how stores that cannot fence in a single statement verify a lease.
	CheckLease(ctx context.Context, lease Lease, now time.Time) error
	RequestCancel(ctx context.Context, id JobID) error
	IsCancelRequested(ctx context.Context, id JobID) (bool, error)
	RequeueExpired(ctx context.Context, input ReapInput) (ReapResult, error)
	PauseQueue(ctx context.Context, name string) error
	ResumeQueue(ctx context.Context, name string) error
	SetQueueRateLimit(ctx context.Context, name string, limit QueueRateLimit) error
	RemoveQueueRateLimit(ctx context.Context, name string) error
	QueueRateLimitTTL(ctx context.Context, name string, now time.Time) (time.Duration, error)
	SetQueueAdmission(ctx context.Context, name string, policy admission.Policy) error
	RemoveQueueAdmission(ctx context.Context, name string) error
}
