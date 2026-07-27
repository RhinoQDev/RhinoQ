package worker

import (
	"context"
	"errors"
	"fmt"
	"math"
	"sync"
	"sync/atomic"
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

// Names lists the queues this worker serves.
func (r *HandlerRegistry) Names() []string {
	r.mu.RLock()
	defer r.mu.RUnlock()
	names := make([]string, 0, len(r.handlers))
	for name := range r.handlers {
		names = append(names, name)
	}
	return names
}

const (
	// DefaultPrefetchFactor claims slightly more than the free slots so a worker
	// is not idle for a full round trip between jobs. Anything higher parks jobs
	// under lease while they wait, which is how leases expire before the work
	// even starts (specification 26).
	DefaultPrefetchFactor = 1.5
	MaxPrefetchFactor     = 3.0
	// DefaultMaxClaimBatch is a hard cap protecting the database, not a target
	// batch size.
	DefaultMaxClaimBatch = 50
)

type Config struct {
	Store    ports.JobStore
	Handlers *HandlerRegistry
	// Owner identifies this worker in every lease it takes. Two workers sharing
	// an owner cannot be told apart by the fencing check.
	Owner       string
	RetryPolicy retry.Policy
	Concurrency int
	// PrefetchFactor multiplies the free slots to size a claim. Defaults to
	// DefaultPrefetchFactor, capped at MaxPrefetchFactor.
	PrefetchFactor float64
	// MaxClaimBatch caps a single claim regardless of free slots.
	MaxClaimBatch  int
	LeaseDuration  time.Duration
	HeartbeatEvery time.Duration
	// PollInterval is the shortest idle wait. An idle worker backs off from here
	// towards MaxPollInterval instead of hammering the database.
	PollInterval    time.Duration
	MaxPollInterval time.Duration
	// ShutdownGrace is how long a stopping worker waits for handlers to finish
	// before it asks them to cancel; CancelGrace is how long it then waits for
	// them to react.
	ShutdownGrace time.Duration
	CancelGrace   time.Duration
	// CompleteWindow bounds the terminal write of a job whose handler already
	// returned. It is deliberately independent of the run context so that a
	// SIGTERM does not turn finished work into a lost lease.
	CompleteWindow time.Duration
	Now            func() time.Time
	// OnError observes non-fatal runtime errors: claim failures, lost leases and
	// failed terminal writes. A worker without one stays silent.
	OnError func(error)

	// ClaimLimit is deprecated: batch size now follows free slots. When set, it
	// is used as MaxClaimBatch.
	ClaimLimit int
}

type Worker struct {
	store           ports.JobStore
	handlers        *HandlerRegistry
	policy          retry.Policy
	owner           string
	concurrency     int
	prefetch        float64
	maxClaimBatch   int
	leaseDuration   time.Duration
	heartbeatEvery  time.Duration
	pollInterval    time.Duration
	maxPollInterval time.Duration
	shutdownGrace   time.Duration
	cancelGrace     time.Duration
	completeWindow  time.Duration
	now             func() time.Time
	onError         func(error)

	slots    chan struct{}
	finished chan struct{}
	inflight atomic.Int64
	claiming atomic.Bool

	mu         sync.Mutex
	running    map[job.ID]context.CancelFunc
	wg         sync.WaitGroup
	shutdownMu sync.Mutex
}

func New(config Config) (*Worker, error) {
	if config.Store == nil || config.Handlers == nil {
		return nil, errors.New("worker store and handlers are required")
	}
	if config.Owner == "" {
		return nil, errors.New("worker owner is required: it is the identity written into every lease")
	}
	if config.Concurrency <= 0 || config.LeaseDuration <= 0 || config.PollInterval <= 0 {
		return nil, errors.New("worker concurrency, lease duration and poll interval must be positive")
	}
	if config.HeartbeatEvery <= 0 || config.HeartbeatEvery >= config.LeaseDuration {
		return nil, errors.New("heartbeat interval must be positive and shorter than lease duration")
	}
	if config.PrefetchFactor <= 0 {
		config.PrefetchFactor = DefaultPrefetchFactor
	}
	if config.PrefetchFactor > MaxPrefetchFactor {
		return nil, fmt.Errorf("prefetch factor must not exceed %.1f", MaxPrefetchFactor)
	}
	if config.MaxClaimBatch <= 0 {
		config.MaxClaimBatch = config.ClaimLimit
	}
	if config.MaxClaimBatch <= 0 {
		config.MaxClaimBatch = DefaultMaxClaimBatch
	}
	if config.MaxPollInterval < config.PollInterval {
		config.MaxPollInterval = config.PollInterval * 10
	}
	if config.ShutdownGrace <= 0 {
		config.ShutdownGrace = 30 * time.Second
	}
	if config.CancelGrace <= 0 {
		config.CancelGrace = 10 * time.Second
	}
	if config.CompleteWindow <= 0 {
		config.CompleteWindow = 10 * time.Second
	}
	if config.Now == nil {
		config.Now = time.Now
	}
	worker := &Worker{
		store: config.Store, handlers: config.Handlers, policy: config.RetryPolicy,
		owner: config.Owner, concurrency: config.Concurrency, prefetch: config.PrefetchFactor,
		maxClaimBatch: config.MaxClaimBatch, leaseDuration: config.LeaseDuration,
		heartbeatEvery: config.HeartbeatEvery, pollInterval: config.PollInterval,
		maxPollInterval: config.MaxPollInterval, shutdownGrace: config.ShutdownGrace,
		cancelGrace: config.CancelGrace, completeWindow: config.CompleteWindow,
		now: config.Now, onError: config.OnError,
		slots:    make(chan struct{}, config.Concurrency),
		finished: make(chan struct{}, 1),
		running:  make(map[job.ID]context.CancelFunc),
	}
	worker.claiming.Store(true)
	return worker, nil
}

// Run keeps the worker's execution slots busy until the context is cancelled.
// Cancelling the context does not abort running handlers: it starts the
// shutdown sequence, which gives them time to finish first.
func (w *Worker) Run(ctx context.Context) error {
	if ctx == nil {
		return errors.New("worker context is required")
	}
	backoff := w.pollInterval
	for {
		if ctx.Err() != nil {
			break
		}
		available := w.concurrency - int(w.inflight.Load())
		if available <= 0 {
			if !w.waitForSlot(ctx) {
				break
			}
			continue
		}
		claimed, err := w.claim(ctx, available)
		if err != nil {
			if ctx.Err() != nil {
				break
			}
			// A claim failure is usually the database being briefly unavailable.
			// Backing off keeps the worker alive to pick the queue back up
			// (specification 50.2) instead of dying on every blip.
			w.report(err)
			if !w.sleep(ctx, backoff) {
				break
			}
			backoff = w.nextBackoff(backoff)
			continue
		}
		if len(claimed) > 0 {
			backoff = w.pollInterval
			for _, record := range claimed {
				w.dispatch(record)
			}
			continue
		}
		if !w.sleep(ctx, w.idleWait(ctx, backoff)) {
			break
		}
		backoff = w.nextBackoff(backoff)
	}
	w.Shutdown(context.WithoutCancel(ctx))
	return ctx.Err()
}

func (w *Worker) claim(ctx context.Context, available int) ([]job.Record, error) {
	if !w.claiming.Load() {
		return nil, nil
	}
	limit := int(math.Ceil(float64(available) * w.prefetch))
	if limit > w.maxClaimBatch {
		limit = w.maxClaimBatch
	}
	if limit < 1 {
		limit = 1
	}
	return w.store.Claim(ctx, ports.ClaimInput{
		Owner: w.owner, Now: w.now(), Limit: limit, LeaseDuration: w.leaseDuration,
	})
}

// idleWait sleeps until the earlier of the backoff and the moment a rate-limited
// queue opens its next window, so a throttled worker wakes up when there is
// something to do rather than on a fixed tick.
func (w *Worker) idleWait(ctx context.Context, backoff time.Duration) time.Duration {
	wait := backoff
	now := w.now()
	for _, name := range w.handlers.Names() {
		ttl, err := w.store.QueueRateLimitTTL(ctx, name, now)
		if err != nil {
			w.report(err)
			continue
		}
		if ttl > 0 && ttl < wait {
			wait = ttl
		}
	}
	return wait
}

func (w *Worker) nextBackoff(current time.Duration) time.Duration {
	next := current * 2
	if next > w.maxPollInterval {
		next = w.maxPollInterval
	}
	return next
}

func (w *Worker) sleep(ctx context.Context, duration time.Duration) bool {
	if duration <= 0 {
		return ctx.Err() == nil
	}
	timer := time.NewTimer(duration)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-w.finished:
		return true
	case <-timer.C:
		return true
	}
}

func (w *Worker) waitForSlot(ctx context.Context) bool {
	select {
	case <-ctx.Done():
		return false
	case <-w.finished:
		return true
	}
}

// dispatch hands one claimed job to its own goroutine. The job takes an
// execution slot before it runs, so prefetched work waits its turn instead of
// blocking the claim loop.
func (w *Worker) dispatch(record job.Record) {
	w.inflight.Add(1)
	w.wg.Add(1)
	go func() {
		defer w.wg.Done()
		defer func() {
			w.inflight.Add(-1)
			select {
			case w.finished <- struct{}{}:
			default:
			}
		}()
		if !w.claiming.Load() {
			w.release(record)
			return
		}
		w.slots <- struct{}{}
		defer func() { <-w.slots }()
		// A worker that started stopping while this job waited for a slot must
		// not begin it: hand the job back instead, attempt included.
		if !w.claiming.Load() {
			w.release(record)
			return
		}
		w.runOne(record)
	}()
}

func (w *Worker) release(record job.Record) {
	ctx, cancel := context.WithTimeout(context.Background(), w.completeWindow)
	defer cancel()
	if err := w.store.ReleaseLease(ctx, ports.LeaseFor(record), w.now()); err != nil {
		w.report(err)
	}
}

func (w *Worker) runOne(record job.Record) {
	lease := ports.LeaseFor(record)
	handler, ok := w.handlers.get(record.Name)
	if !ok {
		w.fail(lease, retry.Permanent, 0, record.Attempts)
		return
	}

	// Handlers do not hang off the run context: a shutdown must be able to let
	// them finish before it decides to cancel them.
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	w.track(record.ID, cancel)
	defer w.untrack(record.ID)

	beat := newHeartbeatState()
	heartbeatDone := make(chan struct{})
	go func() {
		defer close(heartbeatDone)
		w.heartbeat(ctx, cancel, lease, beat)
	}()

	handlerErr := handler(ctx, record)
	cancel()
	<-heartbeatDone

	switch {
	case beat.leaseLost():
		// Another execution owns the job now. Writing anything from here would
		// overwrite live state.
		return
	case beat.cancelRequested():
		w.transition(lease, ports.FailureTransition{State: job.Cancelled})
	case handlerErr == nil:
		w.complete(lease)
	default:
		var classified *ClassifiedError
		if errors.As(handlerErr, &classified) {
			w.fail(lease, classified.Class, classified.RetryAfter, record.Attempts)
			return
		}
		w.fail(lease, retry.Unknown, 0, record.Attempts)
	}
}

// heartbeat renews the lease and learns about cancellation in the same round
// trip. Losing the lease cancels the handler immediately: from that moment the
// job belongs to somebody else.
func (w *Worker) heartbeat(ctx context.Context, cancel context.CancelFunc, lease ports.Lease, beat *heartbeatState) {
	ticker := time.NewTicker(w.heartbeatEvery)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			status, err := w.store.RenewLease(ctx, lease, w.now(), w.leaseDuration)
			if err != nil {
				if ctx.Err() != nil {
					return
				}
				if errors.Is(err, ports.ErrLeaseLost) {
					beat.markLeaseLost()
					w.report(err)
					cancel()
					return
				}
				w.report(err)
				continue
			}
			if status.CancelRequested {
				beat.markCancelRequested()
				cancel()
				return
			}
		}
	}
}

func (w *Worker) complete(lease ports.Lease) {
	ctx, cancel := context.WithTimeout(context.Background(), w.completeWindow)
	defer cancel()
	if err := w.store.Complete(ctx, lease, w.now()); err != nil {
		w.report(err)
	}
}

func (w *Worker) fail(lease ports.Lease, class retry.Class, retryAfter time.Duration, attempt int) {
	decision := w.policy.Decide(class, attempt, w.now(), retryAfter)
	transition := ports.FailureTransition{State: job.Blocked, BlockedReason: job.BlockedUnclassified}
	switch {
	case decision.Retry:
		transition = ports.FailureTransition{State: job.RetryWait, RetryIn: decision.Delay}
	case decision.Dead:
		transition = ports.FailureTransition{State: job.Dead}
	case class == retry.Cancelled:
		transition = ports.FailureTransition{State: job.Cancelled}
	}
	w.transition(lease, transition)
}

func (w *Worker) transition(lease ports.Lease, transition ports.FailureTransition) {
	ctx, cancel := context.WithTimeout(context.Background(), w.completeWindow)
	defer cancel()
	if err := w.store.Fail(ctx, lease, w.now(), transition); err != nil {
		w.report(err)
	}
}

func (w *Worker) track(id job.ID, cancel context.CancelFunc) {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.running[id] = cancel
}

func (w *Worker) untrack(id job.ID) {
	w.mu.Lock()
	defer w.mu.Unlock()
	delete(w.running, id)
}

func (w *Worker) report(err error) {
	if err == nil || w.onError == nil {
		return
	}
	w.onError(err)
}

type heartbeatState struct {
	mu        sync.Mutex
	lost      bool
	cancelled bool
}

func newHeartbeatState() *heartbeatState { return &heartbeatState{} }

func (h *heartbeatState) markLeaseLost() {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.lost = true
}

func (h *heartbeatState) markCancelRequested() {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.cancelled = true
}

func (h *heartbeatState) leaseLost() bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.lost
}

func (h *heartbeatState) cancelRequested() bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.cancelled
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
