// Package queuewatch turns a silent backlog into an explicit operational
// signal. It is intentionally a read-only observer: it never changes job
// state or guesses that retry is safe.
package queuewatch

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"time"

	"github.com/madebyduy/RhinoQ/internal/domain/job"
	"github.com/madebyduy/RhinoQ/internal/ports"
)

type Kind string

const (
	AtRisk          Kind = "queue_at_risk"
	Stuck           Kind = "queue_stuck"
	BacklogGrowing  Kind = "backlog_growing"
	NoWorker        Kind = "no_worker"
	ReaperUnhealthy Kind = "reaper_unhealthy"
)

type Alert struct {
	QueueName       string    `json:"queueName,omitempty"`
	Kind            Kind      `json:"kind"`
	Active          bool      `json:"active"`
	Severity        string    `json:"severity"`
	Message         string    `json:"message"`
	Pending         int64     `json:"pending"`
	RetryWait       int64     `json:"retryWait"`
	Leased          int64     `json:"leased"`
	OldestPendingAt time.Time `json:"oldestPendingAt,omitempty"`
	ObservedAt      time.Time `json:"observedAt"`
}

type Config struct {
	Store ports.JobStore
	// Queues are explicit because a database cannot infer whether an empty
	// queue has a worker or whether a queue name is merely a typo.
	Queues             []string
	Interval           time.Duration
	AtRiskAfter        time.Duration
	StuckAfter         time.Duration
	BacklogGrowthAfter time.Duration
	ReaperTimeout      time.Duration
	Now                func() time.Time
	OnAlert            func(Alert)
	// OnError observes a failed health sample; a transient observer failure
	// must not take the business worker down with it.
	OnError func(error)
	// WorkerReady lets a deployment report whether a registered queue has a
	// live handler. Returning false creates a no_worker alert; nil disables
	// that check rather than making an unsafe guess.
	WorkerReady     func(queueName string) bool
	ReaperLastSweep func() time.Time
}

type Watchdog struct {
	store                                                         ports.JobStore
	queues                                                        []string
	interval, atRiskAfter, stuckAfter, growthAfter, reaperTimeout time.Duration
	now                                                           func() time.Time
	onAlert                                                       func(Alert)
	onError                                                       func(error)
	workerReady                                                   func(string) bool
	reaperLastSweep                                               func() time.Time
	active                                                        map[string]bool
	previous                                                      map[string]sample
	growthSince                                                   map[string]time.Time
}

type sample struct {
	pending int64
	at      time.Time
}

func New(config Config) (*Watchdog, error) {
	if config.Store == nil || config.Now == nil || config.OnAlert == nil {
		return nil, errors.New("queue watchdog store, clock and alert callback are required")
	}
	if config.Interval <= 0 || config.AtRiskAfter <= 0 || config.StuckAfter <= config.AtRiskAfter {
		return nil, errors.New("queue watchdog requires interval and stuckAfter > atRiskAfter > 0")
	}
	if config.BacklogGrowthAfter <= 0 {
		config.BacklogGrowthAfter = config.StuckAfter
	}
	if config.ReaperTimeout <= 0 {
		config.ReaperTimeout = config.Interval * 3
	}
	queues := append([]string(nil), config.Queues...)
	sort.Strings(queues)
	return &Watchdog{
		store: config.Store, queues: unique(queues), interval: config.Interval,
		atRiskAfter: config.AtRiskAfter, stuckAfter: config.StuckAfter,
		growthAfter: config.BacklogGrowthAfter, reaperTimeout: config.ReaperTimeout,
		now: config.Now, onAlert: config.OnAlert, onError: config.OnError, workerReady: config.WorkerReady,
		reaperLastSweep: config.ReaperLastSweep, active: make(map[string]bool),
		previous: make(map[string]sample), growthSince: make(map[string]time.Time),
	}, nil
}

func (w *Watchdog) Run(ctx context.Context) error {
	if ctx == nil {
		return errors.New("queue watchdog context is required")
	}
	ticker := time.NewTicker(w.interval)
	defer ticker.Stop()
	for {
		if _, err := w.Sweep(ctx); err != nil {
			if ctx.Err() != nil {
				return ctx.Err()
			}
			if w.onError != nil {
				w.onError(err)
			}
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-ticker.C:
		}
	}
}

func (w *Watchdog) Sweep(ctx context.Context) ([]Alert, error) {
	now := w.now().UTC()
	alerts := make([]Alert, 0)
	for _, queue := range w.queues {
		health, err := w.health(ctx, queue)
		if err != nil {
			return alerts, err
		}
		alerts = append(alerts, w.evaluate(queue, health, now)...)
	}
	if w.reaperLastSweep != nil {
		last := w.reaperLastSweep()
		active := last.IsZero() || now.Sub(last) > w.reaperTimeout
		alerts = append(alerts, w.emit(Alert{Kind: ReaperUnhealthy, Active: active,
			Severity: "error", Message: fmt.Sprintf("lease recovery sweep is older than %s", w.reaperTimeout), ObservedAt: now}, "global")...)
	}
	return alerts, nil
}

func (w *Watchdog) health(ctx context.Context, queue string) (ports.QueueHealth, error) {
	if reader, ok := w.store.(ports.QueueHealthReader); ok {
		return reader.QueueHealth(ctx, queue)
	}
	counts, err := w.store.JobCounts(ctx, queue)
	if err != nil {
		return ports.QueueHealth{}, err
	}
	return ports.QueueHealth{QueueName: queue, Pending: counts[job.Pending], RetryWait: counts[job.RetryWait], Leased: counts[job.Leased]}, nil
}

func (w *Watchdog) evaluate(queue string, health ports.QueueHealth, now time.Time) []Alert {
	result := make([]Alert, 0, 4)
	oldest := health.OldestPendingAt
	if oldest.IsZero() || (!health.OldestRetryAt.IsZero() && health.OldestRetryAt.Before(oldest)) {
		oldest = health.OldestRetryAt
	}
	age := time.Duration(0)
	if !oldest.IsZero() {
		age = now.Sub(oldest)
	}
	if health.Pending+health.RetryWait > 0 && age >= w.stuckAfter {
		result = append(result, w.emit(w.queueAlert(queue, Stuck, true, "error", health, now), queue)...)
	} else if health.Pending+health.RetryWait > 0 && age >= w.atRiskAfter {
		result = append(result, w.emit(w.queueAlert(queue, AtRisk, true, "warning", health, now), queue)...)
	} else {
		result = append(result, w.emit(w.queueAlert(queue, Stuck, false, "error", health, now), queue)...)
		result = append(result, w.emit(w.queueAlert(queue, AtRisk, false, "warning", health, now), queue)...)
	}
	previous, ok := w.previous[queue]
	if ok && health.Pending+health.RetryWait > previous.pending {
		if _, exists := w.growthSince[queue]; !exists {
			w.growthSince[queue] = previous.at
		}
		if now.Sub(w.growthSince[queue]) >= w.growthAfter {
			result = append(result, w.emit(w.queueAlert(queue, BacklogGrowing, true, "warning", health, now), queue)...)
		}
	} else if health.Pending+health.RetryWait <= previous.pending {
		delete(w.growthSince, queue)
		result = append(result, w.emit(w.queueAlert(queue, BacklogGrowing, false, "warning", health, now), queue)...)
	}
	w.previous[queue] = sample{pending: health.Pending + health.RetryWait, at: now}
	if w.workerReady != nil {
		ready := w.workerReady(queue)
		result = append(result, w.emit(w.queueAlert(queue, NoWorker, !ready && health.Pending+health.RetryWait > 0, "error", health, now), queue)...)
	}
	return result
}

func (w *Watchdog) queueAlert(queue string, kind Kind, active bool, severity string, health ports.QueueHealth, now time.Time) Alert {
	message := fmt.Sprintf("queue %s has %d pending and %d retry-wait job(s)", queue, health.Pending, health.RetryWait)
	if kind == Stuck {
		message = fmt.Sprintf("queue %s has not made progress past the stuck threshold", queue)
	}
	if kind == AtRisk {
		message = fmt.Sprintf("queue %s has pending work older than the at-risk threshold", queue)
	}
	if kind == BacklogGrowing {
		message = fmt.Sprintf("queue %s backlog has kept growing", queue)
	}
	if kind == NoWorker {
		message = fmt.Sprintf("queue %s has pending work but no ready worker", queue)
	}
	return Alert{QueueName: queue, Kind: kind, Active: active, Severity: severity, Message: message,
		Pending: health.Pending, RetryWait: health.RetryWait, Leased: health.Leased,
		OldestPendingAt: health.OldestPendingAt, ObservedAt: now}
}

func (w *Watchdog) emit(alert Alert, scope string) []Alert {
	key := scope + ":" + string(alert.Kind)
	if w.active[key] == alert.Active {
		return nil
	}
	w.active[key] = alert.Active
	w.onAlert(alert)
	return []Alert{alert}
}

func unique(values []string) []string {
	result := make([]string, 0, len(values))
	for _, value := range values {
		if value != "" && (len(result) == 0 || result[len(result)-1] != value) {
			result = append(result, value)
		}
	}
	return result
}
