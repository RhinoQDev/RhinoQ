package ports

import (
	"context"
	"fmt"
	"time"

	"github.com/madebyduy/RhinoQ/internal/domain/admission"
	"github.com/madebyduy/RhinoQ/internal/domain/attempt"
	"github.com/madebyduy/RhinoQ/internal/domain/job"
)

type JobID = job.ID

type EnqueueInput struct {
	// Identity carries the execution lane, the handler contract, the business
	// partition and the resource class as four separate fields.
	job.Identity
	Payload        []byte
	IdempotencyKey string
	// RunAfter is a duration so the store's authoritative clock computes the
	// eligibility timestamp. Producers never send an absolute wall-clock time.
	RunAfter      time.Duration
	CorrelationID string
	// Priority orders claiming inside a lane; higher runs first. Waiting jobs
	// age upwards so a low priority job cannot starve (domain/job scheduling).
	Priority int
}

type ClaimInput struct {
	// Owner identifies the claiming worker. It is stored as the lease owner and
	// must be presented, together with the epoch, by every later operation.
	Owner         string
	Now           time.Time
	Limit         int
	LeaseDuration time.Duration
	// QueueNames restricts claims to the execution lanes this worker subscribes
	// to. It is a lane filter, not a handler filter: a worker claims from a lane
	// and then dispatches by job name. Empty means every lane, which only
	// low-level callers should use.
	QueueNames []string
}

const (
	// MaxClaimQueues bounds one lane filter so an authenticated remote caller
	// cannot create an unbounded SQL statement.
	MaxClaimQueues = 256
	// MaxClaimLimit is the largest batch any worker may lease in one database
	// transaction. It matches the PostgreSQL candidate scan hard cap.
	MaxClaimLimit = 1000
)

func ValidateClaimLimit(limit int) error {
	if limit <= 0 {
		return fmt.Errorf("claim limit must be positive")
	}
	if limit > MaxClaimLimit {
		return fmt.Errorf("claim limit exceeds %d jobs", MaxClaimLimit)
	}
	return nil
}

func ValidateClaimQueues(queueNames []string) error {
	if len(queueNames) > MaxClaimQueues {
		return fmt.Errorf("claim queue filter exceeds %d names", MaxClaimQueues)
	}
	for _, name := range queueNames {
		if name == "" {
			return fmt.Errorf("claim queue names must not be empty")
		}
	}
	return nil
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
	// FailureClass is language-neutral evidence (transient, permanent,
	// rate_limited, dependency_down, cancelled or unknown).
	FailureClass string
}

type QueueRateLimit struct {
	Max    int
	Window time.Duration
}

type ListJobsInput struct {
	// QueueName filters by execution lane and JobName by handler contract.
	// Either may be empty, which means "any".
	QueueName string
	JobName   string
	GroupKey  string
	States    []job.State
	Offset    int
	Limit     int
}

// ReapInput drives one batch of the sweep over expired leases.
type ReapInput struct {
	Now        time.Time
	Protection job.Protection
	// Limit caps how many expired leases one statement may touch. A mass
	// expiry - a deploy that killed every worker, or a network partition -
	// otherwise locks and rewrites every leased row in a single statement, with
	// WAL and lock-hold time proportional to the whole backlog. Zero means
	// DefaultReapBatchLimit.
	Limit int
}

const (
	// DefaultReapBatchLimit is the batch a sweep uses when none is configured.
	DefaultReapBatchLimit = 500
	// MaxReapBatchLimit bounds one statement no matter what a caller asks for.
	MaxReapBatchLimit = 1000
)

// NormalizeReapLimit clamps a requested batch into the supported range.
func NormalizeReapLimit(limit int) int {
	if limit <= 0 {
		return DefaultReapBatchLimit
	}
	if limit > MaxReapBatchLimit {
		return MaxReapBatchLimit
	}
	return limit
}

// ExpiredLease identifies an execution that died. The epoch is what makes the
// clean-up safe: only work opened at or before this epoch belonged to the dead
// execution.
type ExpiredLease struct {
	JobID JobID
	Epoch int64
}

// ReapResult reports what one batch did. Blocked jobs crashed their worker
// often enough to be parked instead of handed to the next one.
type ReapResult struct {
	Requeued int
	Blocked  int
	// Expired lists the executions that lost their lease in this batch, so the
	// effect ledger can be cleaned up after them.
	Expired []ExpiredLease
	// Saturated reports that the batch filled its limit, so more expired leases
	// are probably waiting. The caller decides whether to keep going; the store
	// never loops on its own.
	Saturated bool
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
	ListAttemptEvents(ctx context.Context, id JobID, offset, limit int) ([]attempt.Event, error)
	JobCounts(ctx context.Context, queueName string) (map[job.State]int64, error)
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
