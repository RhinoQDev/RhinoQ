// Package taskscheduler dispatches durable recurring Task occurrences from
// lease-fenced schedule claims. It does not execute Tasks or own retry policy.
package taskscheduler

import (
	"context"
	"errors"
	"strings"
	"time"

	"github.com/madebyduy/RhinoQ/internal/domain/taskschedule"
	"github.com/madebyduy/RhinoQ/internal/ports"
)

type DispatchFunc func(context.Context, taskschedule.Lease, string) error

type Config struct {
	Store                             ports.TaskScheduleStore
	Dispatch                          DispatchFunc
	Owner                             string
	PollInterval, Lease, ErrorBackoff time.Duration
	ClaimBatch                        int
	Now                               func() time.Time
	OnError                           func(error)
}

type Scheduler struct{ config Config }

func New(config Config) (*Scheduler, error) {
	if config.Store == nil || config.Dispatch == nil || strings.TrimSpace(config.Owner) == "" {
		return nil, errors.New("task scheduler requires store, dispatcher and owner")
	}
	if config.PollInterval <= 0 {
		config.PollInterval = time.Second
	}
	if config.Lease <= 0 {
		config.Lease = time.Minute
	}
	if config.ErrorBackoff <= 0 {
		config.ErrorBackoff = 30 * time.Second
	}
	if config.ClaimBatch <= 0 {
		config.ClaimBatch = 16
	}
	if config.ClaimBatch > 100 || config.Lease <= config.PollInterval {
		return nil, errors.New("invalid task scheduler timing or claim batch")
	}
	if config.Now == nil {
		config.Now = func() time.Time { return time.Now().UTC() }
	}
	return &Scheduler{config: config}, nil
}

func (s *Scheduler) Run(ctx context.Context) error {
	timer := time.NewTimer(0)
	defer timer.Stop()
	for {
		select {
		case <-ctx.Done():
			return nil
		case <-timer.C:
		}
		if err := s.RunOnce(ctx); err != nil && s.config.OnError != nil {
			s.config.OnError(err)
		}
		timer.Reset(s.config.PollInterval)
	}
}

func (s *Scheduler) RunOnce(ctx context.Context) error {
	leases, err := s.config.Store.ClaimDueTaskSchedules(ctx, s.config.Owner, s.config.Now(), s.config.Lease, s.config.ClaimBatch)
	if err != nil {
		return err
	}
	var combined error
	for _, lease := range leases {
		occurrenceID, identityErr := taskschedule.OccurrenceID(lease.TenantID, lease.ScheduleID, lease.Occurrence)
		if identityErr != nil {
			combined = errors.Join(combined, identityErr)
			continue
		}
		if dispatchErr := s.config.Dispatch(ctx, lease, occurrenceID); dispatchErr != nil {
			settleErr := s.config.Store.FailTaskSchedule(ctx, lease, s.config.ErrorBackoff, dispatchErr.Error())
			combined = errors.Join(combined, dispatchErr, settleErr)
			continue
		}
		next, nextErr := (taskschedule.Spec{Every: lease.Every, Cron: lease.Cron, Timezone: lease.Timezone}).NextAfter(lease.Occurrence)
		if nextErr != nil {
			combined = errors.Join(combined, nextErr, s.config.Store.FailTaskSchedule(ctx, lease, s.config.ErrorBackoff, nextErr.Error()))
			continue
		}
		combined = errors.Join(combined, s.config.Store.CompleteTaskSchedule(ctx, lease, next))
	}
	return combined
}
