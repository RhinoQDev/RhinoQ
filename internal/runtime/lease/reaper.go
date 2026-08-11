package lease

import (
	"context"
	"errors"
	"sync/atomic"
	"time"

	"github.com/madebyduy/RhinoQ/internal/domain/job"
	"github.com/madebyduy/RhinoQ/internal/ports"
)

type Reaper struct {
	store      ports.JobStore
	effects    ports.EffectStore
	interval   time.Duration
	protection job.Protection
	batchLimit int
	budget     time.Duration
	now        func() time.Time
	observe    func(ports.ReapResult)
	lastSweep  atomic.Int64
}

type Config struct {
	Store ports.JobStore
	// Effects is optional. When set, every sweep also downgrades the effects
	// that dying executions left open.
	Effects  ports.EffectStore
	Interval time.Duration
	// Protection bounds how many times one job may take a worker down before it
	// is parked instead of retried.
	Protection job.Protection
	// BatchLimit caps how many expired leases one statement touches. Defaults to
	// ports.DefaultReapBatchLimit.
	BatchLimit int
	// SweepBudget bounds how long one sweep keeps draining a backlog before it
	// yields until the next tick. Without it a mass expiry would turn the reaper
	// into an unbounded loop competing with live claims for the same rows.
	// Defaults to half the interval.
	SweepBudget time.Duration
	Now         func() time.Time
	// Observe receives the result of every batch, so a deployment can alert on
	// jobs being parked as poison rather than discovering it in the queue view.
	Observe func(ports.ReapResult)
}

func NewReaper(config Config) (*Reaper, error) {
	if config.Store == nil || config.Interval <= 0 || config.Now == nil {
		return nil, errors.New("reaper store, interval and clock are required")
	}
	budget := config.SweepBudget
	if budget <= 0 {
		budget = config.Interval / 2
	}
	if budget <= 0 {
		budget = config.Interval
	}
	reaper := &Reaper{
		store: config.Store, effects: config.Effects, interval: config.Interval,
		protection: config.Protection.Normalize(),
		batchLimit: ports.NormalizeReapLimit(config.BatchLimit),
		budget:     budget,
		now:        config.Now, observe: config.Observe,
	}
	reaper.lastSweep.Store(config.Now().UTC().UnixNano())
	return reaper, nil
}

// LastSweepAt is used by queue health observers. It reports the start of the
// latest bounded sweep, including an empty sweep, so a quiet queue does not
// look like a dead recovery loop.
func (r *Reaper) LastSweepAt() time.Time {
	value := r.lastSweep.Load()
	if value == 0 {
		return time.Time{}
	}
	return time.Unix(0, value).UTC()
}

func (r *Reaper) Run(ctx context.Context) error {
	if ctx == nil {
		return errors.New("reaper context is required")
	}
	ticker := time.NewTicker(r.interval)
	defer ticker.Stop()
	for {
		if _, err := r.Sweep(ctx); err != nil {
			return err
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-ticker.C:
		}
	}
}

// Sweep drains expired leases in bounded batches until the backlog is empty or
// the sweep budget runs out, and returns the total.
//
// Batching is not an optimisation. One statement over every expired lease holds
// locks and writes WAL in proportion to the whole backlog, so the failure it is
// most needed for - a deploy that killed every worker at once - is exactly the
// case where it would stall the database. Draining in batches keeps each
// statement short enough that live claims still make progress between them.
//
// Within a batch the order matters. An effect that was in flight when its
// worker died has an unknown result, and the epoch bound makes the downgrade
// safe even if the job has already been claimed again: only effects from the
// dead execution are touched (specification 42).
func (r *Reaper) Sweep(ctx context.Context) (ports.ReapResult, error) {
	r.lastSweep.Store(r.now().UTC().UnixNano())
	deadline := r.now().Add(r.budget)
	var total ports.ReapResult
	for {
		batch, err := r.store.RequeueExpired(ctx, ports.ReapInput{
			Now: r.now(), Protection: r.protection, Limit: r.batchLimit,
		})
		if err != nil {
			return total, err
		}
		if r.effects != nil && len(batch.Expired) > 0 {
			if _, err := r.effects.MarkPendingUncertain(ctx, batch.Expired); err != nil {
				return total, err
			}
		}
		if r.observe != nil && (batch.Requeued > 0 || batch.Blocked > 0) {
			r.observe(batch)
		}
		total.Requeued += batch.Requeued
		total.Blocked += batch.Blocked
		total.Expired = append(total.Expired, batch.Expired...)

		if !batch.Saturated {
			return total, nil
		}
		// The backlog outlasted this sweep. Report it and let the next tick
		// continue, rather than looping until the database gives up.
		if !r.now().Before(deadline) {
			total.Saturated = true
			return total, nil
		}
		if err := ctx.Err(); err != nil {
			total.Saturated = true
			return total, err
		}
	}
}
