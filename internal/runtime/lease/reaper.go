package lease

import (
	"context"
	"errors"
	"time"

	"github.com/rhinoq/rhinoq/internal/domain/job"
	"github.com/rhinoq/rhinoq/internal/ports"
)

type Reaper struct {
	store      ports.JobStore
	effects    ports.EffectStore
	interval   time.Duration
	protection job.Protection
	now        func() time.Time
	observe    func(ports.ReapResult)
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
	Now        func() time.Time
	// Observe receives the result of every sweep, so a deployment can alert on
	// jobs being parked as poison rather than discovering it in the queue view.
	Observe func(ports.ReapResult)
}

func NewReaper(config Config) (*Reaper, error) {
	if config.Store == nil || config.Interval <= 0 || config.Now == nil {
		return nil, errors.New("reaper store, interval and clock are required")
	}
	return &Reaper{
		store: config.Store, effects: config.Effects, interval: config.Interval,
		protection: config.Protection.Normalize(), now: config.Now, observe: config.Observe,
	}, nil
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

// Sweep requeues everything whose lease expired, parks the jobs that have used
// up their crash budget, and downgrades the effects those executions left open.
//
// The order matters. An effect that was in flight when its worker died has an
// unknown result, and the epoch bound makes the downgrade safe even if the job
// has already been claimed again: only effects from the dead execution are
// touched (specification 42).
func (r *Reaper) Sweep(ctx context.Context) (ports.ReapResult, error) {
	result, err := r.store.RequeueExpired(ctx, ports.ReapInput{Now: r.now(), Protection: r.protection})
	if err != nil {
		return ports.ReapResult{}, err
	}
	if r.effects != nil && len(result.Expired) > 0 {
		if _, err := r.effects.MarkPendingUncertain(ctx, result.Expired); err != nil {
			return result, err
		}
	}
	if r.observe != nil && (result.Requeued > 0 || result.Blocked > 0) {
		r.observe(result)
	}
	return result, nil
}
