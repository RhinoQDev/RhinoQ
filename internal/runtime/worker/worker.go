package worker

import (
	"context"
	"errors"
	"fmt"
	"math"
	"sort"
	"sync"
	"sync/atomic"
	"time"

	"github.com/madebyduy/RhinoQ/internal/domain/job"
	"github.com/madebyduy/RhinoQ/internal/domain/retry"
	"github.com/madebyduy/RhinoQ/internal/ports"
)

type Handler func(context.Context, job.Record) error

// routeKey identifies one handler registration. A handler is bound to a
// (lane, contract) pair rather than to a bare name, so the same contract can be
// served in more than one lane and one lane can carry unrelated contracts.
type routeKey struct {
	queueName string
	jobName   string
}

type HandlerRegistry struct {
	mu       sync.RWMutex
	handlers map[routeKey]Handler
	// queueNames counts registrations per lane, so the claim filter can be built
	// without walking every route and so the lane count stays bounded.
	queueNames map[string]int
}

func NewHandlerRegistry() *HandlerRegistry {
	return &HandlerRegistry{
		handlers:   make(map[routeKey]Handler),
		queueNames: make(map[string]int),
	}
}

// Register binds a handler to one contract inside one lane. Both names are
// required: a handler that does not say which lane it serves cannot be claimed
// for, because claiming happens per lane.
func (r *HandlerRegistry) Register(queueName, jobName string, handler Handler) error {
	if queueName == "" || jobName == "" || handler == nil {
		return errors.New("handler queue name, job name and function are required")
	}
	key := routeKey{queueName: queueName, jobName: jobName}
	r.mu.Lock()
	defer r.mu.Unlock()
	if _, exists := r.handlers[key]; exists {
		return fmt.Errorf("handler already registered: %s in queue %s", jobName, queueName)
	}
	// The bound is on lanes, not routes: the lane list is what becomes a SQL
	// filter, so that is what a remote caller could otherwise inflate.
	if _, known := r.queueNames[queueName]; !known && len(r.queueNames) >= ports.MaxClaimQueues {
		return fmt.Errorf("worker may subscribe to at most %d queues", ports.MaxClaimQueues)
	}
	r.handlers[key] = handler
	r.queueNames[queueName]++
	return nil
}

func (r *HandlerRegistry) get(queueName, jobName string) (Handler, bool) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	handler, ok := r.handlers[routeKey{queueName: queueName, jobName: jobName}]
	return handler, ok
}

// QueueNames lists the execution lanes this worker subscribes to. It is the
// claim filter, and it is deliberately not the list of handler contracts: a
// worker claims a lane and then dispatches by contract.
func (r *HandlerRegistry) QueueNames() []string {
	r.mu.RLock()
	defer r.mu.RUnlock()
	names := make([]string, 0, len(r.queueNames))
	for name := range r.queueNames {
		names = append(names, name)
	}
	sort.Strings(names)
	return names
}

// Routes lists every registered (queue, job) pair. It exists for diagnostics
// and for the Gateway's capability report, not for claiming.
func (r *HandlerRegistry) Routes() [][2]string {
	r.mu.RLock()
	defer r.mu.RUnlock()
	routes := make([][2]string, 0, len(r.handlers))
	for key := range r.handlers {
		routes = append(routes, [2]string{key.queueName, key.jobName})
	}
	sort.Slice(routes, func(i, j int) bool {
		if routes[i][0] == routes[j][0] {
			return routes[i][1] < routes[j][1]
		}
		return routes[i][0] < routes[j][0]
	})
	return routes
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
	Effects  ports.EffectStore
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

	// Metrics receives handler duration observations. It is optional: a worker
	// built without one measures nothing. It is a port, not a concrete holder,
	// because the layer rules keep the runtime free of infrastructure.
	Metrics ports.ExecutionObserver

	// ClaimLimit is deprecated: batch size now follows free slots. When set, it
	// is used as MaxClaimBatch.
	ClaimLimit int
}

type Worker struct {
	store           ports.JobStore
	effects         ports.EffectStore
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
	metrics         ports.ExecutionObserver

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
	if len(config.Handlers.QueueNames()) == 0 {
		return nil, errors.New("worker requires at least one registered handler")
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
	if err := ports.ValidateClaimLimit(config.MaxClaimBatch); err != nil {
		return nil, fmt.Errorf("worker max claim batch: %w", err)
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
		store: config.Store, effects: config.Effects, handlers: config.Handlers, policy: config.RetryPolicy,
		owner: config.Owner, concurrency: config.Concurrency, prefetch: config.PrefetchFactor,
		maxClaimBatch: config.MaxClaimBatch, leaseDuration: config.LeaseDuration,
		heartbeatEvery: config.HeartbeatEvery, pollInterval: config.PollInterval,
		maxPollInterval: config.MaxPollInterval, shutdownGrace: config.ShutdownGrace,
		cancelGrace: config.CancelGrace, completeWindow: config.CompleteWindow,
		now: config.Now, onError: config.OnError, metrics: config.Metrics,
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
	var wake <-chan string
	if subscriber, ok := w.store.(ports.JobWakeSubscriber); ok {
		var err error
		wake, err = subscriber.SubscribeJobWake(ctx)
		if err != nil {
			w.report(fmt.Errorf("subscribe job wake hints: %w", err))
		}
	}
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
			if !w.sleepWithWake(ctx, backoff, wake) {
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
		if !w.sleepWithWake(ctx, w.idleWait(ctx, backoff), wake) {
			break
		}
		backoff = w.nextBackoff(backoff)
	}
	w.Shutdown(context.WithoutCancel(ctx))
	return ctx.Err()
}

func (w *Worker) sleepWithWake(ctx context.Context, duration time.Duration, wake <-chan string) bool {
	if wake == nil {
		return w.sleep(ctx, duration)
	}
	if duration <= 0 {
		return ctx.Err() == nil
	}
	timer := time.NewTimer(duration)
	defer timer.Stop()
	queues := make(map[string]struct{}, len(w.handlers.QueueNames()))
	for _, name := range w.handlers.QueueNames() {
		queues[name] = struct{}{}
	}
	for {
		select {
		case <-ctx.Done():
			return false
		case <-w.finished:
			return true
		case <-timer.C:
			return true
		case name, open := <-wake:
			if !open {
				wake = nil
				continue
			}
			if _, interested := queues[name]; interested {
				return true
			}
		}
	}
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
		QueueNames: w.handlers.QueueNames(),
	})
}

// idleWait sleeps until the earlier of the backoff and the moment a rate-limited
// queue opens its next window, so a throttled worker wakes up when there is
// something to do rather than on a fixed tick.
// One query for the whole subscription, not one per lane. A worker subscribed
// to thirty lanes used to issue thirty queries on every idle tick, and an idle
// worker ticks as often as its poll interval — so a pool of workers with
// nothing to do generated a steady load on the very database they were idle
// waiting on. The answer is a single MIN over the lanes.
func (w *Worker) idleWait(ctx context.Context, backoff time.Duration) time.Duration {
	ttl, err := w.store.NextQueueRateLimitTTL(ctx, w.handlers.QueueNames(), w.now())
	if err != nil {
		w.report(err)
		return backoff
	}
	if ttl > 0 && ttl < backoff {
		return ttl
	}
	return backoff
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
	handler, ok := w.handlers.get(record.QueueName, record.JobName)
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

	// The two instants bracket the handler call and nothing else. Including the
	// heartbeat join or the terminal write would report RhinoQ's own overhead as
	// the application's execution time.
	startedAt := w.now()
	handlerErr := handler(ctx, record)
	// The nil check is on the interface, not the implementation: an unset port is
	// a nil interface, and calling a method on one panics rather than doing
	// nothing the way a nil pointer receiver would.
	if w.metrics != nil {
		w.metrics.ObserveExecution(record.QueueName, w.now().Sub(startedAt))
	}
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
	transition.FailureClass = string(class)
	w.transition(lease, transition)
}

func (w *Worker) transition(lease ports.Lease, transition ports.FailureTransition) {
	ctx, cancel := context.WithTimeout(context.Background(), w.completeWindow)
	defer cancel()
	if err := w.store.Fail(ctx, lease, w.now(), transition); err != nil {
		w.report(err)
		return
	}
	if w.effects != nil {
		if _, err := w.effects.MarkPendingUncertain(ctx, []ports.ExpiredLease{{
			JobID: lease.JobID, Epoch: lease.Epoch,
		}}); err != nil {
			w.report(err)
		}
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
