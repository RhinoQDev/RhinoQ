package lease

import (
	"context"
	"errors"
	"time"

	"github.com/rhinoq/rhinoq/internal/ports"
)

type Reaper struct {
	store    ports.JobStore
	interval time.Duration
	now      func() time.Time
}

func NewReaper(store ports.JobStore, interval time.Duration, now func() time.Time) (*Reaper, error) {
	if store == nil || interval <= 0 || now == nil {
		return nil, errors.New("reaper store, interval and clock are required")
	}
	return &Reaper{store: store, interval: interval, now: now}, nil
}

func (r *Reaper) Run(ctx context.Context) error {
	if ctx == nil {
		return errors.New("reaper context is required")
	}
	ticker := time.NewTicker(r.interval)
	defer ticker.Stop()
	for {
		if _, err := r.store.RequeueExpired(ctx, r.now()); err != nil {
			return err
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-ticker.C:
		}
	}
}
