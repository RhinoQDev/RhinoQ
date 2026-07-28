package rhinoq

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"strings"
	"time"

	"github.com/madebyduy/RhinoQ/internal/domain/job"
	"github.com/madebyduy/RhinoQ/internal/domain/retry"
	"github.com/madebyduy/RhinoQ/internal/ports"
)

// LeaseToken is what a remote worker holds for one execution. It is opaque to
// the SDK and must be sent back with every operation on the job: the epoch is
// what tells a live execution apart from one that already lost the job.
type LeaseToken struct {
	JobID string `json:"jobId"`
	Owner string `json:"owner"`
	Epoch int64  `json:"epoch"`
}

// LeasedJob is one claimed job handed to a worker.
type LeasedJob struct {
	Job     JobSummary `json:"job"`
	Payload []byte     `json:"payload"`
	Lease   LeaseToken `json:"lease"`
	// ExpiresAt is the database's deadline, not the worker's. A worker must
	// renew before this instant or stop working on the job.
	ExpiresAt time.Time `json:"expiresAt"`
}

// ClaimRequest asks for work on behalf of one worker.
type ClaimRequest struct {
	// Worker identifies the caller and is written into every lease it takes.
	Worker string `json:"worker"`
	// Limit is how many jobs to claim. A worker should ask for what it can
	// actually run.
	Limit int `json:"limit"`
	// LeaseFor is how long the claim is valid. Defaults to one minute.
	LeaseFor time.Duration `json:"leaseForMs"`
	// Queues restricts this worker to job names for which it has handlers.
	// Empty keeps the low-level all-queues behavior for compatibility.
	QueueNames []string `json:"queueNames,omitempty"`
}

// LeaseState is what a heartbeat learns.
type LeaseState struct {
	ExpiresAt       time.Time `json:"expiresAt"`
	CancelRequested bool      `json:"cancelRequested"`
}

// Retry classes decide what happens to a failed job. They are part of the
// cross-language contract: an SDK translates its native exception into one of
// these, and the engine never parses a language-specific stack trace.
const (
	RetryTransient      = string(retry.Transient)
	RetryPermanent      = string(retry.Permanent)
	RetryRateLimited    = string(retry.RateLimited)
	RetryDependencyDown = string(retry.DependencyDown)
	RetryCancelled      = string(retry.Cancelled)
	RetryUnknown        = string(retry.Unknown)
)

// FailureReport is the language-neutral error envelope. Without one, the same
// provider outage produces a different fingerprint in every SDK and nothing can
// group them (specification 53.2).
type FailureReport struct {
	// Type is the SDK's own error name, kept for display only.
	Type string `json:"type"`
	// RetryClass decides the outcome. An empty or unrecognised class is treated
	// as unknown, which is retried cautiously and then parked - never retried
	// blindly.
	RetryClass string `json:"retryClass"`
	Message    string `json:"message"`
	// Fingerprint groups identical failures. RhinoQ derives one when the SDK
	// does not send it.
	Fingerprint string            `json:"fingerprint"`
	Details     map[string]string `json:"details,omitempty"`
	Language    string            `json:"language,omitempty"`
	// RetryAfter is the provider's own instruction, used by rate_limited.
	RetryAfter time.Duration `json:"retryAfterMs,omitempty"`
	// Attempt is which attempt failed. The engine uses the stored attempt count
	// when this is zero.
	Attempt int `json:"attempt,omitempty"`
}

// GroupingKey returns the report's fingerprint, deriving a stable one from the
// queue, class and message when the SDK did not supply it. Identical failures
// must group the same way no matter which language reported them.
func (r FailureReport) GroupingKey(queue string) string {
	if strings.TrimSpace(r.Fingerprint) != "" {
		return r.Fingerprint
	}
	sum := sha256.Sum256([]byte(strings.Join([]string{queue, r.RetryClass, r.Type, r.Message}, "\n")))
	return "sha256:" + hex.EncodeToString(sum[:])
}

func (r FailureReport) class() retry.Class {
	switch retry.Class(r.RetryClass) {
	case retry.Transient, retry.Permanent, retry.RateLimited, retry.DependencyDown, retry.Cancelled:
		return retry.Class(r.RetryClass)
	default:
		return retry.Unknown
	}
}

// ClaimJobs leases a batch of jobs for a worker. It is how a non-Go SDK receives
// work: the engine keeps claiming, leasing and ordering, and the SDK only runs
// handlers.
func (c *Client) ClaimJobs(ctx context.Context, request ClaimRequest) ([]LeasedJob, error) {
	if c == nil || c.store == nil {
		return nil, errors.New("rhinoq store is required")
	}
	if request.Worker == "" {
		return nil, errors.New("a worker name is required: it is the identity written into every lease")
	}
	if request.Limit <= 0 {
		request.Limit = 1
	}
	if err := ports.ValidateClaimLimit(request.Limit); err != nil {
		return nil, err
	}
	if request.LeaseFor <= 0 {
		request.LeaseFor = time.Minute
	}
	request.QueueNames = uniqueStrings(request.QueueNames)
	if err := ports.ValidateClaimQueues(request.QueueNames); err != nil {
		return nil, err
	}
	records, err := c.store.Claim(ctx, ports.ClaimInput{
		Owner: request.Worker, Now: time.Now().UTC(),
		Limit: request.Limit, LeaseDuration: request.LeaseFor,
		QueueNames: request.QueueNames,
	})
	if err != nil {
		return nil, err
	}
	leased := make([]LeasedJob, 0, len(records))
	for _, record := range records {
		token := ports.LeaseFor(record)
		leased = append(leased, LeasedJob{
			Job:       summarizeJob(record),
			Payload:   append([]byte(nil), record.Payload...),
			Lease:     LeaseToken{JobID: string(token.JobID), Owner: token.Owner, Epoch: token.Epoch},
			ExpiresAt: token.ExpiresAt,
		})
	}
	return leased, nil
}

func uniqueStrings(values []string) []string {
	if len(values) < 2 {
		return append([]string(nil), values...)
	}
	seen := make(map[string]struct{}, len(values))
	result := make([]string, 0, len(values))
	for _, value := range values {
		if _, exists := seen[value]; exists {
			continue
		}
		seen[value] = struct{}{}
		result = append(result, value)
	}
	return result
}

// Heartbeat extends a lease and reports whether the job has been cancelled, in
// one round trip.
func (c *Client) Heartbeat(ctx context.Context, token LeaseToken, extend time.Duration) (LeaseState, error) {
	if c == nil || c.store == nil {
		return LeaseState{}, errors.New("rhinoq store is required")
	}
	if extend <= 0 {
		extend = time.Minute
	}
	status, err := c.store.RenewLease(ctx, leaseOf(token), time.Now().UTC(), extend)
	if err != nil {
		return LeaseState{}, err
	}
	return LeaseState{ExpiresAt: status.ExpiresAt, CancelRequested: status.CancelRequested}, nil
}

// CompleteJob records a successful execution.
func (c *Client) CompleteJob(ctx context.Context, token LeaseToken) error {
	if c == nil || c.store == nil {
		return errors.New("rhinoq store is required")
	}
	return c.store.Complete(ctx, leaseOf(token), time.Now().UTC())
}

// ReleaseJob hands back a job the worker claimed but never started, together
// with the attempt it consumed.
func (c *Client) ReleaseJob(ctx context.Context, token LeaseToken) error {
	if c == nil || c.store == nil {
		return errors.New("rhinoq store is required")
	}
	return c.store.ReleaseLease(ctx, leaseOf(token), time.Now().UTC())
}

// FailJob records a failed execution and applies the retry policy to the
// reported class.
func (c *Client) FailJob(ctx context.Context, token LeaseToken, report FailureReport) (JobSummary, error) {
	if c == nil || c.store == nil {
		return JobSummary{}, errors.New("rhinoq store is required")
	}
	attempt := report.Attempt
	if attempt <= 0 {
		record, found, err := c.store.Get(ctx, ports.JobID(token.JobID))
		if err != nil {
			return JobSummary{}, err
		}
		if !found {
			return JobSummary{}, ports.ErrJobNotFound
		}
		attempt = record.Attempts
	}
	decision := c.retryPolicy().Decide(report.class(), attempt, time.Now().UTC(), report.RetryAfter)
	transition := ports.FailureTransition{State: job.Blocked, BlockedReason: job.BlockedUnclassified}
	switch {
	case decision.Retry:
		transition = ports.FailureTransition{State: job.RetryWait, RetryIn: decision.Delay}
	case decision.Dead:
		transition = ports.FailureTransition{State: job.Dead}
	case report.class() == retry.Cancelled:
		transition = ports.FailureTransition{State: job.Cancelled}
	}
	transition.FailureClass = string(report.class())
	if err := c.store.Fail(ctx, leaseOf(token), time.Now().UTC(), transition); err != nil {
		return JobSummary{}, err
	}
	if c.effects != nil {
		if _, err := c.effects.MarkPendingUncertain(ctx, []ports.ExpiredLease{{
			JobID: ports.JobID(token.JobID), Epoch: token.Epoch,
		}}); err != nil {
			return JobSummary{}, err
		}
	}
	record, found, err := c.store.Get(ctx, ports.JobID(token.JobID))
	if err != nil || !found {
		return JobSummary{}, err
	}
	return summarizeJob(record), nil
}

// BeginEffect opens an effect for a remote worker. It is the same fenced write
// the in-process helper performs, exposed so an SDK in any language gets the
// same protection.
func (c *Client) BeginEffect(ctx context.Context, token LeaseToken, request EffectRequest) (EffectResult, error) {
	remote := Job{ID: token.JobID, client: c, lease: leaseOf(token)}
	return remote.beginEffect(ctx, request)
}

// ResolveEffect records the result of an effect a remote worker already ran.
func (c *Client) ResolveEffect(ctx context.Context, token LeaseToken, request EffectRequest, reference string, outcome EffectOutcome) (EffectResult, error) {
	remote := Job{ID: token.JobID, client: c, lease: leaseOf(token)}
	return remote.resolveEffect(ctx, request, reference, outcome)
}

func (c *Client) retryPolicy() retry.Policy {
	if c.retry.MaxAttempts > 0 {
		return c.retry
	}
	return retry.Policy{MaxAttempts: 3, BaseDelay: time.Second, MaxDelay: time.Minute, Jitter: 0.2}
}

func leaseOf(token LeaseToken) ports.Lease {
	return ports.Lease{JobID: ports.JobID(token.JobID), Owner: token.Owner, Epoch: token.Epoch}
}
