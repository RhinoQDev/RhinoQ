package rhinoq

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"os"
	"time"

	"github.com/madebyduy/RhinoQ/internal/adapters/memory"
	"github.com/madebyduy/RhinoQ/internal/adapters/postgres"
	attentionapp "github.com/madebyduy/RhinoQ/internal/application/attention"
	"github.com/madebyduy/RhinoQ/internal/application/operations"
	"github.com/madebyduy/RhinoQ/internal/domain/admission"
	"github.com/madebyduy/RhinoQ/internal/domain/attempt"
	"github.com/madebyduy/RhinoQ/internal/domain/job"
	"github.com/madebyduy/RhinoQ/internal/domain/outcome"
	"github.com/madebyduy/RhinoQ/internal/domain/recovery"
	"github.com/madebyduy/RhinoQ/internal/domain/retry"
	"github.com/madebyduy/RhinoQ/internal/ports"
	"github.com/madebyduy/RhinoQ/internal/runtime/lease"
	"github.com/madebyduy/RhinoQ/internal/runtime/supervisor"
	"github.com/madebyduy/RhinoQ/internal/runtime/worker"
)

type Job struct {
	ID string
	// QueueName is the execution lane this job was claimed from; JobName is the
	// handler contract that routed it here; GroupKey is the business partition,
	// usually a tenant or customer, and may be empty.
	QueueName     string
	JobName       string
	GroupKey      string
	Payload       []byte
	Attempts      int
	CorrelationID string

	// client and lease are what let a handler record an effect under the same
	// fencing token the runtime is holding for this execution.
	client *Client
	lease  ports.Lease
}

type Handler func(context.Context, Job) error

var (
	ErrJobNotFound            = ports.ErrJobNotFound
	ErrReplayInvalidRequest   = recovery.ErrInvalidReplayRequest
	ErrReplayInvalidState     = recovery.ErrReplayState
	ErrReplayConfirmedEffect  = recovery.ErrConfirmedEffect
	ErrReplayUncertainEffect  = recovery.ErrUncertainEffect
	ErrReplayUnresolvedEffect = recovery.ErrUnresolvedEffect
	// ErrQueueOverCapacity reports that admission control refused an enqueue.
	// The error value carries the queue, the budget and a retry hint.
	ErrQueueOverCapacity = admission.ErrOverCapacity
	// ErrLeaseLost reports that an execution no longer owns its job. A handler
	// that sees it must stop: another worker is running the same job.
	ErrLeaseLost = ports.ErrLeaseLost
)

// Resource classes decide which share of a queue's admission budget work may
// use, and what is shed first when the database is under pressure.
const (
	ResourceCritical    = string(job.Critical)
	ResourceInteractive = string(job.Interactive)
	ResourceStandard    = string(job.Standard)
	ResourceBatch       = string(job.Batch)
	ResourceMaintenance = string(job.Maintenance)
)

// Overflow modes for admission control.
const (
	OverflowReject = string(admission.Reject)
	OverflowDelay  = string(admission.Delay)
)

const (
	AttentionDeadJob          = "dead_job"
	AttentionExecutionBlocked = "execution_blocked"
	AttentionEffectUncertain  = "effect_uncertain"
	AttentionOutcomeMismatch  = "outcome_mismatch"
	AttentionIntegrityFinding = "integrity_finding"
)

// JobRequest is the single canonical way to enqueue. Everything a job needs is
// declared here; there is no second configuration surface.
type JobRequest struct {
	// QueueName is the execution lane. Concurrency, rate limits, pausing and
	// admission budgets all belong to the lane, so two handlers that must share
	// a worker pool share a lane, and a handler that needs its own limit gets
	// its own lane.
	QueueName string
	// JobName is the handler contract. It decides which registered handler runs
	// the job, and nothing else.
	JobName string
	// GroupKey is the business partition, usually a tenant or customer. It is
	// stored and indexed but does not yet change scheduling.
	GroupKey string
	Payload  []byte
	// IdempotencyKey is scoped to QueueName: enqueueing the same key twice into
	// one lane returns the first job instead of creating a second one. The same
	// key in a different lane is a different job.
	IdempotencyKey string
	// CorrelationID links this job to the business entity it acts on.
	CorrelationID string
	// Priority orders claiming inside a lane, from -100 to 100. Waiting jobs
	// gain priority over time, so low priority work cannot starve.
	Priority int
	// ResourceClass defaults to standard. Critical work may use a lane's
	// reserved admission budget.
	ResourceClass string
	// RunAfter delays the earliest run time. Zero means as soon as possible.
	RunAfter time.Duration
}

type JobQuery struct {
	// QueueName, JobName and GroupKey each narrow the result; an empty field
	// means "any".
	QueueName string
	JobName   string
	GroupKey  string
	States    []string
	Offset    int
	Limit     int
}

type JobSummary struct {
	ID              string    `json:"id"`
	QueueName       string    `json:"queueName"`
	JobName         string    `json:"jobName"`
	GroupKey        string    `json:"groupKey,omitempty"`
	State           string    `json:"state"`
	ResourceClass   string    `json:"resourceClass"`
	Priority        int       `json:"priority"`
	Attempts        int       `json:"attempts"`
	CrashCount      int       `json:"crashCount"`
	BlockedReason   string    `json:"blockedReason,omitempty"`
	CorrelationID   string    `json:"correlationId,omitempty"`
	CreatedAt       time.Time `json:"createdAt"`
	NotBefore       time.Time `json:"notBefore"`
	CancelRequested bool      `json:"cancelRequested"`
}

type AttentionItem struct {
	Kind        string    `json:"kind"`
	JobID       string    `json:"jobId,omitempty"`
	Queue       string    `json:"queue,omitempty"`
	JobState    string    `json:"jobState,omitempty"`
	ReferenceID string    `json:"referenceId,omitempty"`
	Reason      string    `json:"reason"`
	ObservedAt  time.Time `json:"observedAt"`
}

type AuditRecord struct {
	ID         string    `json:"id"`
	JobID      string    `json:"jobId"`
	Action     string    `json:"action"`
	Actor      string    `json:"actor"`
	Reason     string    `json:"reason"`
	OccurredAt time.Time `json:"occurredAt"`
	PrevHash   string    `json:"prevHash,omitempty"`
	RowHash    string    `json:"rowHash"`
}

// AttemptEvent is one immutable fact in a job's execution timeline.
type AttemptEvent struct {
	Sequence      int64     `json:"sequence"`
	JobID         string    `json:"jobId"`
	Attempt       int       `json:"attempt"`
	LeaseOwner    string    `json:"leaseOwner"`
	LeaseEpoch    int64     `json:"leaseEpoch"`
	Kind          string    `json:"kind"`
	ResultState   string    `json:"resultState,omitempty"`
	FailureClass  string    `json:"failureClass,omitempty"`
	BlockedReason string    `json:"blockedReason,omitempty"`
	OccurredAt    time.Time `json:"occurredAt"`
}

// EffectEvidence is one declared external effect attached to a job.
type EffectEvidence struct {
	ID             string    `json:"id"`
	JobID          string    `json:"jobId,omitempty"`
	SourceSystem   string    `json:"sourceSystem"`
	SourceID       string    `json:"sourceId"`
	SubjectType    string    `json:"subjectType,omitempty"`
	SubjectID      string    `json:"subjectId,omitempty"`
	BusinessKey    string    `json:"businessKey,omitempty"`
	Name           string    `json:"name"`
	IdempotencyKey string    `json:"idempotencyKey"`
	State          string    `json:"state"`
	Irreversible   bool      `json:"irreversible"`
	ExternalRef    string    `json:"externalRef,omitempty"`
	CreatedAt      time.Time `json:"createdAt"`
	LeaseEpoch     int64     `json:"leaseEpoch"`
}

// OutcomeEvidence is one versioned observation of a declared business result.
type OutcomeEvidence struct {
	ID              string    `json:"id"`
	JobID           string    `json:"jobId"`
	ContractVersion int       `json:"contractVersion"`
	State           string    `json:"state"`
	Reason          string    `json:"reason,omitempty"`
	ObservedVersion int64     `json:"observedVersion"`
	UpdatedAt       time.Time `json:"updatedAt"`
}

// AdmissionPolicy is the producer backpressure budget for one queue.
type AdmissionPolicy struct {
	// MaxPending is how many pending and retrying jobs the queue may hold.
	MaxPending int
	// ReservedCritical is the part of MaxPending only critical jobs may use.
	ReservedCritical int
	// OnOverflow is OverflowReject or OverflowDelay. Default is reject.
	OnOverflow string
	// DelayBy is how far OverflowDelay pushes the earliest run time.
	DelayBy time.Duration
	// RetryAfter is what a rejected producer is told to wait.
	RetryAfter time.Duration
}

// WorkerConfig tunes one worker process. Every field has a working default.
type WorkerConfig struct {
	// Name identifies this worker in every lease it takes. Defaults to
	// hostname-pid. Use a unique name per process for clear operational
	// attribution; epoch fencing still rejects stale writes if names collide.
	Name string
	// Concurrency is how many handlers may run at once.
	Concurrency int
	// Prefetch multiplies the free slots when sizing a claim, so a worker is not
	// idle for a round trip between jobs. Defaults to 1.5, maximum 3.
	Prefetch float64
	// MaxClaimBatch caps a single claim to protect the database.
	MaxClaimBatch int
	// Lease is how long a claim is valid; Heartbeat is how often it is renewed.
	Lease     time.Duration
	Heartbeat time.Duration
	// PollInterval is the shortest idle wait; an idle worker backs off towards
	// MaxPollInterval and wakes early when a rate limit window opens.
	PollInterval    time.Duration
	MaxPollInterval time.Duration
	// ShutdownGrace is how long a stopping worker lets handlers finish before it
	// cancels them; CancelGrace is how long it then waits for them to react.
	ShutdownGrace time.Duration
	CancelGrace   time.Duration
	// MaxAttempts bounds retries of a failing job.
	MaxAttempts int
	// RetryBaseDelay and RetryMaxDelay bound exponential backoff.
	RetryBaseDelay time.Duration
	RetryMaxDelay  time.Duration
	// ReaperInterval is how often expired leases are swept back into the queue.
	ReaperInterval time.Duration
	// ReapBatchLimit caps how many expired leases one statement touches, so a
	// mass expiry is drained in bounded units instead of one statement whose
	// lock time and WAL scale with the size of the outage. Defaults to 500.
	ReapBatchLimit int
	// ReapSweepBudget bounds how long one sweep keeps draining before yielding
	// until the next tick, so recovery cannot starve live claims. Defaults to
	// half the reaper interval.
	ReapSweepBudget time.Duration
	// MaxWorkerCrashes is how many times one job may take a worker down before
	// it is parked as a poison job instead of retried.
	MaxWorkerCrashes int
	// OnError observes non-fatal runtime errors instead of losing them.
	OnError func(error)
}

func (c WorkerConfig) withDefaults() WorkerConfig {
	if c.Name == "" {
		host, err := os.Hostname()
		if err != nil || host == "" {
			host = "rhinoq-worker"
		}
		c.Name = fmt.Sprintf("%s-%d", host, os.Getpid())
	}
	if c.Concurrency <= 0 {
		c.Concurrency = 4
	}
	if c.Lease <= 0 {
		c.Lease = time.Minute
	}
	if c.Heartbeat <= 0 {
		c.Heartbeat = c.Lease / 3
	}
	if c.PollInterval <= 0 {
		c.PollInterval = 100 * time.Millisecond
	}
	if c.MaxPollInterval <= 0 {
		c.MaxPollInterval = 2 * time.Second
	}
	if c.MaxAttempts <= 0 {
		c.MaxAttempts = 3
	}
	if c.RetryBaseDelay <= 0 {
		c.RetryBaseDelay = time.Second
	}
	if c.RetryMaxDelay <= 0 {
		c.RetryMaxDelay = time.Minute
	}
	if c.ReaperInterval <= 0 {
		c.ReaperInterval = 30 * time.Second
	}
	if c.ReapSweepBudget <= 0 {
		c.ReapSweepBudget = c.ReaperInterval / 2
	}
	if c.ReapSweepBudget > c.ReaperInterval {
		// A sweep that outlasts its own tick never yields to live claims.
		c.ReapSweepBudget = c.ReaperInterval
	}
	return c
}

// Client is the full RhinoQ surface: the runtime plane (enqueue, workers,
// leases, effects, recovery) plus the integrity plane it embeds.
//
// Embedding rather than duplicating means a Client can do everything an
// IntegrityClient can - RegisterRule, Scan, ListFindings and the rest are
// promoted - while a team that only needs verification can take
// NewIntegrity(db) and never see a queue.
type Client struct {
	*IntegrityClient
	store    ports.JobStore
	effects  ports.EffectStore
	outcomes ports.OutcomeStore
	recovery ports.RecoveryStore
	handlers *worker.HandlerRegistry
	// retry is the policy applied to failures reported through the remote
	// worker API, where no in-process worker owns a policy.
	retry retry.Policy
}

// SetRetryPolicy configures how failures reported by remote workers are
// classified into retry, dead or blocked.
func (c *Client) SetRetryPolicy(maxAttempts int, baseDelay, maxDelay time.Duration) error {
	if c == nil {
		return errors.New("rhinoq client is required")
	}
	if maxAttempts <= 0 || baseDelay <= 0 || maxDelay < baseDelay {
		return errors.New("retry policy needs a positive attempt limit and a max delay at or above the base delay")
	}
	c.retry = retry.Policy{MaxAttempts: maxAttempts, BaseDelay: baseDelay, MaxDelay: maxDelay, Jitter: 0.2}
	return nil
}

func NewInMemory() *Client {
	jobs := memory.NewJobStore()
	effects, err := memory.NewEffectStore(jobs)
	if err != nil {
		panic(err)
	}
	outcomes := memory.NewOutcomeStore()
	findingStore := memory.NewFindingStore()
	ruleStore := memory.NewRuleStore()
	recoveryStore, err := memory.NewRecoveryStore(jobs, effects, outcomes)
	if err != nil {
		panic(err)
	}
	return &Client{
		store: jobs, effects: effects, outcomes: outcomes, recovery: recoveryStore,
		IntegrityClient: &IntegrityClient{
			findings: findingStore, rules: ruleStore, ruleSchedules: ruleStore,
		},

		handlers: worker.NewHandlerRegistry(),
	}
}

func NewPostgres(db *sql.DB) (*Client, error) {
	store, err := postgres.NewJobStore(db)
	if err != nil {
		return nil, err
	}
	effects, err := postgres.NewEffectStore(db)
	if err != nil {
		return nil, err
	}
	outcomes, err := postgres.NewOutcomeStore(db)
	if err != nil {
		return nil, err
	}
	recoveryStore, err := postgres.NewRecoveryStore(db)
	if err != nil {
		return nil, err
	}
	findingStore, err := postgres.NewFindingStore(db)
	if err != nil {
		return nil, err
	}
	ruleStore, err := postgres.NewRuleStore(db)
	if err != nil {
		return nil, err
	}
	ruleExplainer, err := postgres.NewRuleExplainer(db, nil)
	if err != nil {
		return nil, err
	}
	ruleEvaluator, err := postgres.NewRuleEvaluator(db, nil)
	if err != nil {
		return nil, err
	}
	return &Client{
		store: store, effects: effects, outcomes: outcomes, recovery: recoveryStore,
		IntegrityClient: &IntegrityClient{
			findings: findingStore, rules: ruleStore, ruleExplainer: ruleExplainer,
			ruleEvaluator: ruleEvaluator, ruleSchedules: ruleStore,
		},

		handlers: worker.NewHandlerRegistry(),
	}, nil
}

func NewWithStore(store ports.JobStore) *Client {
	// The embedded facade must exist before anything assigns through it:
	// promoted field writes on a nil embedded pointer compile and then panic.
	client := &Client{
		IntegrityClient: &IntegrityClient{},
		store:           store,
		handlers:        worker.NewHandlerRegistry(),
	}
	if recoveryStore, ok := store.(ports.RecoveryStore); ok {
		client.recovery = recoveryStore
	}
	if outcomeStore, ok := store.(ports.OutcomeStore); ok {
		client.outcomes = outcomeStore
	}
	if findingStore, ok := store.(ports.FindingStore); ok {
		client.findings = findingStore
	}
	if ruleStore, ok := store.(ports.RuleStore); ok {
		client.rules = ruleStore
	}
	if explainer, ok := store.(ports.RuleExplainer); ok {
		client.ruleExplainer = explainer
	}
	if evaluator, ok := store.(ports.RuleEvaluator); ok {
		client.ruleEvaluator = evaluator
	}
	if schedules, ok := store.(ports.RuleScheduleStore); ok {
		client.ruleSchedules = schedules
	}
	return client
}

type RuleSchedulerConfig struct {
	Owner        string
	PollInterval time.Duration
	Lease        time.Duration
	ErrorBackoff time.Duration
	ClaimBatch   int
	OnError      func(error)
}

// RunRuleScheduler evaluates enabled table Rules from durable bounded cursors.
// Multiple processes may run it; owner/epoch fencing lets only the current
// schedule lease advance or complete a page.
// RunRuleScheduler is the runtime-plane name for IntegrityClient.RunScheduler.
// It is kept so an application that already runs it through *Client does not
// have to change, and it deliberately shares one implementation: a second copy
// of the scheduler wiring would be a second place for fencing to drift.
func (c *Client) RunRuleScheduler(
	ctx context.Context,
	config RuleSchedulerConfig,
) error {
	if c == nil || c.IntegrityClient == nil {
		return errors.New("rhinoq rule scheduler store is not configured")
	}
	return c.IntegrityClient.RunScheduler(ctx, config)
}

// Enqueue admits one job. It returns ErrQueueOverCapacity when the queue has an
// admission budget and that budget is full.
func (c *Client) Enqueue(ctx context.Context, request JobRequest) (string, error) {
	if c == nil || c.store == nil {
		return "", errors.New("rhinoq store is required")
	}
	if request.RunAfter < 0 {
		return "", errors.New("rhinoq run-after delay must not be negative")
	}
	input := ports.EnqueueInput{
		Identity: job.Identity{
			QueueName:     request.QueueName,
			JobName:       request.JobName,
			GroupKey:      request.GroupKey,
			ResourceClass: job.Class(request.ResourceClass),
		},
		Payload:        request.Payload,
		IdempotencyKey: request.IdempotencyKey,
		CorrelationID:  request.CorrelationID,
		Priority:       request.Priority,
		RunAfter:       request.RunAfter,
	}
	id, err := c.store.Enqueue(ctx, input)
	return string(id), err
}

func (c *Client) Cancel(ctx context.Context, id string) error {
	if c == nil || c.store == nil {
		return errors.New("rhinoq store is required")
	}
	if id == "" {
		return errors.New("job id is required")
	}
	return c.store.RequestCancel(ctx, ports.JobID(id))
}

// Pause stops a queue being claimed without touching jobs already running.
func (c *Client) Pause(ctx context.Context, queue string) error {
	control, err := c.queueControl()
	if err != nil {
		return err
	}
	return control.Pause(ctx, queue)
}

func (c *Client) Resume(ctx context.Context, queue string) error {
	control, err := c.queueControl()
	if err != nil {
		return err
	}
	return control.Resume(ctx, queue)
}

func (c *Client) SetRateLimit(ctx context.Context, queue string, max int, window time.Duration) error {
	control, err := c.queueControl()
	if err != nil {
		return err
	}
	return control.SetRateLimit(ctx, queue, max, window)
}

func (c *Client) RemoveRateLimit(ctx context.Context, queue string) error {
	control, err := c.queueControl()
	if err != nil {
		return err
	}
	return control.RemoveRateLimit(ctx, queue)
}

func (c *Client) RateLimitTTL(ctx context.Context, queue string) (time.Duration, error) {
	control, err := c.queueControl()
	if err != nil {
		return 0, err
	}
	return control.RateLimitTTL(ctx, queue, time.Now().UTC())
}

// SetAdmission installs producer backpressure on a queue.
func (c *Client) SetAdmission(ctx context.Context, queue string, policy AdmissionPolicy) error {
	control, err := c.queueControl()
	if err != nil {
		return err
	}
	return control.SetAdmission(ctx, queue, admission.Policy{
		MaxPending:       policy.MaxPending,
		ReservedCritical: policy.ReservedCritical,
		OnOverflow:       admission.Mode(policy.OnOverflow),
		DelayBy:          policy.DelayBy,
		RetryAfter:       policy.RetryAfter,
	})
}

func (c *Client) RemoveAdmission(ctx context.Context, queue string) error {
	control, err := c.queueControl()
	if err != nil {
		return err
	}
	return control.RemoveAdmission(ctx, queue)
}

func (c *Client) ListJobs(ctx context.Context, query JobQuery) ([]JobSummary, error) {
	if c == nil || c.store == nil {
		return nil, errors.New("rhinoq store is required")
	}
	states := make([]job.State, 0, len(query.States))
	for _, state := range query.States {
		states = append(states, job.State(state))
	}
	inspection, err := operations.NewQueueInspection(c.store)
	if err != nil {
		return nil, err
	}
	records, err := inspection.List(ctx, ports.ListJobsInput{
		QueueName: query.QueueName, JobName: query.JobName, GroupKey: query.GroupKey,
		States: states, Offset: query.Offset, Limit: query.Limit,
	})
	if err != nil {
		return nil, err
	}
	summaries := make([]JobSummary, 0, len(records))
	for _, record := range records {
		summaries = append(summaries, summarizeJob(record))
	}
	return summaries, nil
}

// GetJob returns one payload-free job summary for inspection.
func (c *Client) GetJob(ctx context.Context, id string) (JobSummary, error) {
	if c == nil || c.store == nil {
		return JobSummary{}, errors.New("rhinoq store is required")
	}
	if id == "" {
		return JobSummary{}, errors.New("job id is required")
	}
	record, found, err := c.store.Get(ctx, ports.JobID(id))
	if err != nil {
		return JobSummary{}, err
	}
	if !found {
		return JobSummary{}, ports.ErrJobNotFound
	}
	return summarizeJob(record), nil
}

func (c *Client) JobCounts(ctx context.Context, queue string) (map[string]int64, error) {
	if c == nil || c.store == nil {
		return nil, errors.New("rhinoq store is required")
	}
	inspection, err := operations.NewQueueInspection(c.store)
	if err != nil {
		return nil, err
	}
	counts, err := inspection.Counts(ctx, queue)
	if err != nil {
		return nil, err
	}
	result := make(map[string]int64, len(counts))
	for state, count := range counts {
		result[state.String()] = count
	}
	return result, nil
}

// AttemptTimeline returns append-only execution evidence in sequence order.
func (c *Client) AttemptTimeline(ctx context.Context, id string, offset, limit int) ([]AttemptEvent, error) {
	if c == nil || c.store == nil {
		return nil, errors.New("rhinoq store is required")
	}
	if limit == 0 {
		limit = 50
	}
	events, err := c.store.ListAttemptEvents(ctx, ports.JobID(id), offset, limit)
	if err != nil {
		return nil, err
	}
	result := make([]AttemptEvent, 0, len(events))
	for _, event := range events {
		result = append(result, summarizeAttempt(event))
	}
	return result, nil
}

// ListEffectEvidence returns bounded Effect Ledger entries in creation order.
// It reports current ledger state; effect transition history is not implied.
func (c *Client) ListEffectEvidence(ctx context.Context, id string, offset, limit int) ([]EffectEvidence, error) {
	if c == nil || c.effects == nil {
		return nil, ErrEffectLedgerMissing
	}
	if limit == 0 {
		limit = 50
	}
	reader, ok := c.effects.(ports.EffectReader)
	if !ok {
		return nil, errors.New("rhinoq effect inspection is not configured")
	}
	records, err := reader.ListEffects(ctx, id, offset, limit)
	if err != nil {
		return nil, err
	}
	result := make([]EffectEvidence, 0, len(records))
	for _, record := range records {
		result = append(result, publicEffect(record))
	}
	return result, nil
}

// ListOutcomeEvidence returns bounded current verification evidence ordered by
// contract version. Execution success is intentionally not treated as an
// achieved outcome, and this API does not imply append-only observation history.
func (c *Client) ListOutcomeEvidence(ctx context.Context, id string, offset, limit int) ([]OutcomeEvidence, error) {
	if c == nil || c.outcomes == nil {
		return nil, errors.New("rhinoq outcome store is not configured")
	}
	if limit == 0 {
		limit = 50
	}
	reader, ok := c.outcomes.(ports.OutcomeReader)
	if !ok {
		return nil, errors.New("rhinoq outcome inspection is not configured")
	}
	records, err := reader.ListOutcomes(ctx, id, offset, limit)
	if err != nil {
		return nil, err
	}
	result := make([]OutcomeEvidence, 0, len(records))
	for _, record := range records {
		result = append(result, summarizeOutcome(record))
	}
	return result, nil
}

func (c *Client) ListAttention(ctx context.Context, queue string, offset, limit int) ([]AttentionItem, error) {
	if c == nil || c.recovery == nil {
		return nil, errors.New("rhinoq recovery store is not configured")
	}
	service, err := attentionapp.New(
		c.recovery, c.findings, func() time.Time { return time.Now().UTC() },
	)
	if err != nil {
		return nil, err
	}
	items, err := service.List(ctx, recovery.AttentionQuery{
		Queue: queue, Offset: offset, Limit: limit,
	})
	if err != nil {
		return nil, err
	}
	result := make([]AttentionItem, 0, len(items))
	for _, item := range items {
		result = append(result, AttentionItem{
			Kind: string(item.Kind), JobID: item.JobID.String(), Queue: item.Queue,
			JobState: item.JobState.String(), ReferenceID: item.ReferenceID,
			Reason: item.Reason, ObservedAt: item.ObservedAt,
		})
	}
	return result, nil
}

func (c *Client) ReplayJob(ctx context.Context, id, actor, reason string) (JobSummary, AuditRecord, error) {
	if c == nil || c.recovery == nil {
		return JobSummary{}, AuditRecord{}, errors.New("rhinoq recovery store is not configured")
	}
	service, err := operations.NewRecovery(c.recovery)
	if err != nil {
		return JobSummary{}, AuditRecord{}, err
	}
	record, audit, err := service.Replay(ctx, recovery.ReplayRequest{
		JobID: job.ID(id), Actor: actor, Reason: reason, RequestedAt: time.Now().UTC(),
	})
	if err != nil {
		return JobSummary{}, AuditRecord{}, err
	}
	return summarizeJob(record), summarizeAudit(audit), nil
}

func (c *Client) AuditTrail(ctx context.Context, id string, offset, limit int) ([]AuditRecord, error) {
	if c == nil || c.recovery == nil {
		return nil, errors.New("rhinoq recovery store is not configured")
	}
	service, err := operations.NewRecovery(c.recovery)
	if err != nil {
		return nil, err
	}
	records, err := service.AuditTrail(ctx, job.ID(id), offset, limit)
	if err != nil {
		return nil, err
	}
	result := make([]AuditRecord, 0, len(records))
	for _, record := range records {
		result = append(result, summarizeAudit(record))
	}
	return result, nil
}

// Handle binds a handler to one job contract inside one execution lane. The
// worker claims from queueName and dispatches by jobName, so registering the
// same jobName in two lanes runs the same contract in both, and registering two
// jobNames in one lane lets unrelated work share a worker pool.
func (c *Client) Handle(queueName, jobName string, handler Handler) error {
	if c == nil || c.handlers == nil {
		return errors.New("rhinoq client is required")
	}
	if handler == nil {
		return errors.New("rhinoq handler is required")
	}
	return c.handlers.Register(queueName, jobName, func(ctx context.Context, record job.Record) error {
		return handler(ctx, Job{
			ID:        string(record.ID),
			QueueName: record.QueueName,
			JobName:   record.JobName,
			GroupKey:  record.GroupKey,
			Payload:   append([]byte(nil), record.Payload...), Attempts: record.Attempts,
			CorrelationID: record.CorrelationID,
			client:        c, lease: ports.LeaseFor(record),
		})
	})
}

// Run works the registered queues with default settings until the context is
// cancelled, then shuts down gracefully. It also sweeps expired leases, so a
// single-process deployment recovers crashed work without extra wiring.
func (c *Client) Run(ctx context.Context) error {
	return c.RunWorker(ctx, WorkerConfig{})
}

// RunWorker is Run with explicit settings.
func (c *Client) RunWorker(ctx context.Context, config WorkerConfig) error {
	if c == nil || c.store == nil || c.handlers == nil {
		return errors.New("rhinoq client is not configured")
	}
	settings := config.withDefaults()
	runtime, err := worker.New(worker.Config{
		Store: c.store, Effects: c.effects, Handlers: c.handlers, Owner: settings.Name,
		RetryPolicy: retry.Policy{
			MaxAttempts: settings.MaxAttempts, BaseDelay: settings.RetryBaseDelay,
			MaxDelay: settings.RetryMaxDelay, Jitter: 0.2,
		},
		Concurrency: settings.Concurrency, PrefetchFactor: settings.Prefetch,
		MaxClaimBatch: settings.MaxClaimBatch, LeaseDuration: settings.Lease,
		HeartbeatEvery: settings.Heartbeat, PollInterval: settings.PollInterval,
		MaxPollInterval: settings.MaxPollInterval, ShutdownGrace: settings.ShutdownGrace,
		CancelGrace: settings.CancelGrace, OnError: settings.OnError,
	})
	if err != nil {
		return err
	}
	reaper, err := lease.NewReaper(lease.Config{
		Store: c.store, Effects: c.effects, Interval: settings.ReaperInterval,
		Protection: job.Protection{MaxWorkerCrashesPerJob: settings.MaxWorkerCrashes},
		BatchLimit: settings.ReapBatchLimit, SweepBudget: settings.ReapSweepBudget,
		Now: func() time.Time { return time.Now().UTC() },
	})
	if err != nil {
		return err
	}
	group, err := supervisor.New(runtime, reaper)
	if err != nil {
		return err
	}
	return group.Run(ctx)
}

func (c *Client) queueControl() (*operations.QueueControl, error) {
	if c == nil || c.store == nil {
		return nil, errors.New("rhinoq store is required")
	}
	return operations.NewQueueControl(c.store)
}

func summarizeJob(record job.Record) JobSummary {
	return JobSummary{
		ID: record.ID.String(), QueueName: record.QueueName,
		JobName: record.JobName, GroupKey: record.GroupKey,
		State:         record.State.String(),
		ResourceClass: string(record.ResourceClass), Priority: record.Priority,
		Attempts: record.Attempts, CrashCount: record.CrashCount,
		BlockedReason: string(record.BlockedReason), CorrelationID: record.CorrelationID,
		CreatedAt: record.CreatedAt, NotBefore: record.NotBefore,
		CancelRequested: record.CancelRequested,
	}
}

func summarizeAudit(record recovery.AuditRecord) AuditRecord {
	return AuditRecord{
		ID: record.ID, JobID: record.JobID.String(), Action: record.Action,
		Actor: record.Actor, Reason: record.Reason, OccurredAt: record.OccurredAt,
		PrevHash: record.PrevHash, RowHash: record.RowHash,
	}
}

func summarizeAttempt(event attempt.Event) AttemptEvent {
	return AttemptEvent{
		Sequence: event.Sequence, JobID: event.JobID.String(), Attempt: event.Attempt,
		LeaseOwner: event.LeaseOwner, LeaseEpoch: event.LeaseEpoch,
		Kind: string(event.Kind), ResultState: event.ResultState.String(),
		FailureClass: event.FailureClass, BlockedReason: string(event.BlockedReason),
		OccurredAt: event.OccurredAt,
	}
}

func summarizeOutcome(record outcome.Record) OutcomeEvidence {
	return OutcomeEvidence{
		ID: record.ID, JobID: record.JobID,
		ContractVersion: record.ContractVersion, State: string(record.State),
		Reason: record.Reason, ObservedVersion: record.ObservedVersion,
		UpdatedAt: record.UpdatedAt,
	}
}
