package rhinoq

import (
	"context"
	"database/sql"
	"errors"
	"time"

	"github.com/rhinoq/rhinoq/internal/adapters/memory"
	"github.com/rhinoq/rhinoq/internal/adapters/postgres"
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
		RetryPolicy: retry.Policy{MaxAttempts: 3, BaseDelay: time.Second, MaxDelay: time.Minute},
		ClaimLimit:  10, Concurrency: 4, LeaseDuration: time.Minute,
		PollInterval: 10 * time.Millisecond, HeartbeatEvery: 20 * time.Second,
	})
	if err != nil {
		return err
	}
	return runtime.Run(ctx)
}
