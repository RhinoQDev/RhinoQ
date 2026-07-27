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

type Client struct {
	store    ports.JobStore
	handlers *worker.HandlerRegistry
}

func NewInMemory() *Client {
	return &Client{store: memory.NewJobStore(), handlers: worker.NewHandlerRegistry()}
}

func NewPostgres(db *sql.DB) (*Client, error) {
	store, err := postgres.NewJobStore(db)
	if err != nil {
		return nil, err
	}
	return NewWithStore(store), nil
}

func NewWithStore(store ports.JobStore) *Client {
	return &Client{store: store, handlers: worker.NewHandlerRegistry()}
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
