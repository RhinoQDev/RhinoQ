package worker

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"time"

	"github.com/rhinoq/rhinoq/internal/domain/job"
	"github.com/rhinoq/rhinoq/internal/domain/retry"
	"github.com/rhinoq/rhinoq/internal/ports"
)

type Handler func(context.Context, job.Record) error

type HandlerRegistry struct {
	mu       sync.RWMutex
	handlers map[string]Handler
}

func NewHandlerRegistry() *HandlerRegistry {
	return &HandlerRegistry{handlers: make(map[string]Handler)}
}

func (r *HandlerRegistry) Register(name string, handler Handler) error {
	if name == "" || handler == nil {
		return errors.New("handler name and function are required")
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if _, exists := r.handlers[name]; exists {
		return fmt.Errorf("handler already registered: %s", name)
	}
	r.handlers[name] = handler
	return nil
}

func (r *HandlerRegistry) get(name string) (Handler, bool) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	handler, ok := r.handlers[name]
	return handler, ok
}

type Worker struct {
	store          ports.JobStore
	handlers       *HandlerRegistry
	policy         retry.Policy
	claimLimit     int
	leaseDuration  time.Duration
	pollInterval   time.Duration
	heartbeatEvery time.Duration
	concurrency    int
	now            func() time.Time
}

type Config struct {
	Store          ports.JobStore
	Handlers       *HandlerRegistry
	RetryPolicy    retry.Policy
	ClaimLimit     int
	LeaseDuration  time.Duration
	PollInterval   time.Duration
	HeartbeatEvery time.Duration
	Concurrency    int
	Now            func() time.Time
}

func New(config Config) (*Worker, error) {
	if config.Store == nil || config.Handlers == nil {
		return nil, errors.New("worker store and handlers are required")
	}
	if config.ClaimLimit <= 0 || config.LeaseDuration <= 0 || config.PollInterval <= 0 || config.Concurrency <= 0 {
		return nil, errors.New("worker claim limit, lease duration, poll interval and concurrency must be positive")
	}
	if config.HeartbeatEvery <= 0 || config.HeartbeatEvery >= config.LeaseDuration {
		return nil, errors.New("heartbeat interval must be positive and shorter than lease duration")
	}
	if config.Now == nil {
		config.Now = time.Now
	}
	return &Worker{
		store: config.Store, handlers: config.Handlers, policy: config.RetryPolicy,
		claimLimit: config.ClaimLimit, leaseDuration: config.LeaseDuration,
		pollInterval: config.PollInterval, heartbeatEvery: config.HeartbeatEvery,
		concurrency: config.Concurrency,
		now:         config.Now,
	}, nil
}

func (w *Worker) Run(ctx context.Context) error {
	if ctx == nil {
		return errors.New("worker context is required")
	}
	ticker := time.NewTicker(w.pollInterval)
	defer ticker.Stop()
	for {
		if err := w.poll(ctx); err != nil && !errors.Is(err, context.Canceled) {
			return err
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-ticker.C:
		}
	}
}

func (w *Worker) poll(ctx context.Context) error {
	claimed, err := w.store.Claim(ctx, ports.ClaimInput{Now: w.now(), Limit: w.claimLimit, LeaseDuration: w.leaseDuration})
	if err != nil {
		return err
	}
	sem := make(chan struct{}, w.concurrency)
	var wg sync.WaitGroup
	for _, record := range claimed {
		select {
		case <-ctx.Done():
			wg.Wait()
			return ctx.Err()
		case sem <- struct{}{}:
		}
		wg.Add(1)
		go func(record job.Record) {
			defer wg.Done()
			defer func() { <-sem }()
			_ = w.runOne(ctx, record)
		}(record)
	}
	wg.Wait()
	if ctx.Err() != nil {
		return ctx.Err()
	}
	return nil
}

func (w *Worker) runOne(parent context.Context, record job.Record) error {
	handler, ok := w.handlers.get(record.Name)
	lease := ports.Lease{JobID: ports.JobID(record.ID), LeaseID: record.LeaseID}
	if !ok {
		return w.fail(parent, lease, retry.Permanent, 0, errors.New("handler not registered"), record.Attempts)
	}

	ctx, cancel := context.WithCancel(parent)
	defer cancel()
	heartbeatErr := make(chan error, 1)
	cancelRequested := make(chan struct{}, 1)
	go w.heartbeat(ctx, cancel, lease, heartbeatErr, cancelRequested)
	handlerErr := handler(ctx, record)
	cancel()
	select {
	case <-cancelRequested:
		return w.store.Fail(parent, lease, w.now(), ports.FailureTransition{State: job.Cancelled, NotBefore: w.now()})
	default:
	}
	select {
	case err := <-heartbeatErr:
		if err != nil && handlerErr == nil {
			return err
		}
	default:
	}

	now := w.now()
	if handlerErr == nil {
		return w.store.Complete(parent, lease, now)
	}
	var classified *ClassifiedError
	if errors.As(handlerErr, &classified) {
		return w.fail(parent, lease, classified.Class, classified.RetryAfter, classified.Err, record.Attempts)
	}
	return w.fail(parent, lease, retry.Unknown, 0, handlerErr, record.Attempts)
}

func (w *Worker) heartbeat(ctx context.Context, cancel context.CancelFunc, lease ports.Lease, result chan<- error, cancelRequested chan<- struct{}) {
	ticker := time.NewTicker(w.heartbeatEvery)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case now := <-ticker.C:
			requested, err := w.store.IsCancelRequested(ctx, lease.JobID)
			if err != nil {
				cancel()
				result <- err
				return
			}
			if requested {
				cancel()
				cancelRequested <- struct{}{}
				return
			}
			if err := w.store.RenewLease(ctx, lease, now, w.leaseDuration); err != nil {
				cancel()
				result <- err
				return
			}
		}
	}
}

func (w *Worker) fail(ctx context.Context, lease ports.Lease, class retry.Class, retryAfter time.Duration, _ error, attempt int) error {
	now := w.now()
	decision := w.policy.Decide(class, attempt, now, retryAfter)
	state := job.Blocked
	if decision.Retry {
		state = job.RetryWait
	} else if decision.Dead {
		state = job.Dead
	}
	return w.store.Fail(ctx, lease, now, ports.FailureTransition{State: state, NotBefore: decision.NextRunAt})
}

type ClassifiedError struct {
	Class      retry.Class
	RetryAfter time.Duration
	Err        error
}

func (e *ClassifiedError) Error() string { return e.Err.Error() }
func (e *ClassifiedError) Unwrap() error { return e.Err }

func Classify(err error, class retry.Class, retryAfter time.Duration) error {
	if err == nil {
		return nil
	}
	return &ClassifiedError{Class: class, RetryAfter: retryAfter, Err: err}
}
