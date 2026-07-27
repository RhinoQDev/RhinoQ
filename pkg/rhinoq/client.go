package rhinoq

import (
	"context"
	"database/sql"
	"errors"
	"time"

	"github.com/rhinoq/rhinoq/internal/adapters/memory"
	"github.com/rhinoq/rhinoq/internal/adapters/postgres"
	"github.com/rhinoq/rhinoq/internal/application/operations"
	"github.com/rhinoq/rhinoq/internal/domain/job"
	"github.com/rhinoq/rhinoq/internal/domain/recovery"
	"github.com/rhinoq/rhinoq/internal/domain/retry"
	"github.com/rhinoq/rhinoq/internal/ports"
	"github.com/rhinoq/rhinoq/internal/runtime/worker"
)

type Job struct {
	ID       string
	Name     string
	Payload  []byte
	Attempts int
}

type Handler func(context.Context, Job) error

var (
	ErrReplayInvalidRequest   = recovery.ErrInvalidReplayRequest
	ErrReplayInvalidState     = recovery.ErrReplayState
	ErrReplayConfirmedEffect  = recovery.ErrConfirmedEffect
	ErrReplayUncertainEffect  = recovery.ErrUncertainEffect
	ErrReplayUnresolvedEffect = recovery.ErrUnresolvedEffect
)

const (
	AttentionDeadJob          = "dead_job"
	AttentionExecutionBlocked = "execution_blocked"
	AttentionEffectUncertain  = "effect_uncertain"
	AttentionOutcomeMismatch  = "outcome_mismatch"
)

type JobQuery struct {
	Queue  string
	States []string
	Offset int
	Limit  int
}

type JobSummary struct {
	ID              string
	Name            string
	State           string
	Attempts        int
	CorrelationID   string
	CreatedAt       time.Time
	NotBefore       time.Time
	CancelRequested bool
}

type AttentionItem struct {
	Kind        string
	JobID       string
	Queue       string
	JobState    string
	ReferenceID string
	Reason      string
	ObservedAt  time.Time
}

type AuditRecord struct {
	ID         string
	JobID      string
	Action     string
	Actor      string
	Reason     string
	OccurredAt time.Time
	PrevHash   string
	RowHash    string
}

type Client struct {
	store    ports.JobStore
	recovery ports.RecoveryStore
	handlers *worker.HandlerRegistry
}

func NewInMemory() *Client {
	jobs := memory.NewJobStore()
	effects := memory.NewEffectStore()
	outcomes := memory.NewOutcomeStore()
	recoveryStore, err := memory.NewRecoveryStore(jobs, effects, outcomes)
	if err != nil {
		panic(err)
	}
	return &Client{store: jobs, recovery: recoveryStore, handlers: worker.NewHandlerRegistry()}
}

func NewPostgres(db *sql.DB) (*Client, error) {
	store, err := postgres.NewJobStore(db)
	if err != nil {
		return nil, err
	}
	recoveryStore, err := postgres.NewRecoveryStore(db)
	if err != nil {
		return nil, err
	}
	return &Client{store: store, recovery: recoveryStore, handlers: worker.NewHandlerRegistry()}, nil
}

func NewWithStore(store ports.JobStore) *Client {
	client := &Client{store: store, handlers: worker.NewHandlerRegistry()}
	if recoveryStore, ok := store.(ports.RecoveryStore); ok {
		client.recovery = recoveryStore
	}
	return client
}

func (c *Client) Enqueue(ctx context.Context, name string, payload []byte, idempotencyKey string) (string, error) {
	if c == nil || c.store == nil {
		return "", errors.New("rhinoq store is required")
	}
	id, err := c.store.Enqueue(ctx, ports.EnqueueInput{Name: name, Payload: payload, IdempotencyKey: idempotencyKey})
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

func (c *Client) SetRateLimit(ctx context.Context, queue string, max int, window time.Duration) error {
	if c == nil || c.store == nil {
		return errors.New("rhinoq store is required")
	}
	return c.store.SetQueueRateLimit(ctx, queue, ports.QueueRateLimit{Max: max, Window: window})
}

func (c *Client) RemoveRateLimit(ctx context.Context, queue string) error {
	if c == nil || c.store == nil {
		return errors.New("rhinoq store is required")
	}
	return c.store.RemoveQueueRateLimit(ctx, queue)
}

func (c *Client) RateLimitTTL(ctx context.Context, queue string) (time.Duration, error) {
	if c == nil || c.store == nil {
		return 0, errors.New("rhinoq store is required")
	}
	return c.store.QueueRateLimitTTL(ctx, queue, time.Now().UTC())
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
		Name: query.Queue, States: states, Offset: query.Offset, Limit: query.Limit,
	})
	if err != nil {
		return nil, err
	}
	summaries := make([]JobSummary, 0, len(records))
	for _, record := range records {
		summaries = append(summaries, JobSummary{
			ID: string(record.ID), Name: record.Name, State: record.State.String(),
			Attempts: record.Attempts, CorrelationID: record.CorrelationID,
			CreatedAt: record.CreatedAt, NotBefore: record.NotBefore,
			CancelRequested: record.CancelRequested,
		})
	}
	return summaries, nil
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

func (c *Client) ListAttention(ctx context.Context, queue string, offset, limit int) ([]AttentionItem, error) {
	if c == nil || c.recovery == nil {
		return nil, errors.New("rhinoq recovery store is not configured")
	}
	service, err := operations.NewRecovery(c.recovery)
	if err != nil {
		return nil, err
	}
	items, err := service.ListAttention(ctx, recovery.AttentionQuery{
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

func (c *Client) Handle(name string, handler Handler) error {
	if c == nil || c.handlers == nil {
		return errors.New("rhinoq client is required")
	}
	if handler == nil {
		return errors.New("rhinoq handler is required")
	}
	return c.handlers.Register(name, func(ctx context.Context, record job.Record) error {
		return handler(ctx, Job{ID: string(record.ID), Name: record.Name, Payload: append([]byte(nil), record.Payload...), Attempts: record.Attempts})
	})
}

func (c *Client) Run(ctx context.Context) error {
	if c == nil || c.store == nil || c.handlers == nil {
		return errors.New("rhinoq client is not configured")
	}
	runtime, err := worker.New(worker.Config{
		Store: c.store, Handlers: c.handlers,
		RetryPolicy: retry.Policy{MaxAttempts: 3, BaseDelay: time.Second, MaxDelay: time.Minute, Jitter: 0.2},
		ClaimLimit:  10, Concurrency: 4, LeaseDuration: time.Minute,
		PollInterval: 10 * time.Millisecond, HeartbeatEvery: 20 * time.Second,
	})
	if err != nil {
		return err
	}
	return runtime.Run(ctx)
}

func summarizeJob(record job.Record) JobSummary {
	return JobSummary{
		ID: record.ID.String(), Name: record.Name, State: record.State.String(),
		Attempts: record.Attempts, CorrelationID: record.CorrelationID,
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
