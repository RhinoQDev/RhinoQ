package notifications

import (
	"context"
	"errors"
	"strings"
	"time"

	"github.com/madebyduy/RhinoQ/internal/domain/notificationdelivery"
	"github.com/madebyduy/RhinoQ/internal/ports"
)

// Scheduler sends already-enqueued notification deliveries. The application
// supplies Send because only it knows how a destination ID resolves to a
// secret and a concrete receiver. Ownership, retry timing and dead-lettering
// stay in the durable delivery ledger.
type Scheduler struct {
	store       ports.NotificationDeliveryLeaseStore
	owner       string
	lease       time.Duration
	every       time.Duration
	maxAttempts int
	backoff     func(int) time.Duration
	now         func() time.Time
	send        func(context.Context, notificationdelivery.Record) error
	onError     func(error)
}

type SchedulerOptions struct {
	Store       ports.NotificationDeliveryLeaseStore
	Owner       string
	Lease       time.Duration
	Every       time.Duration
	MaxAttempts int
	Backoff     func(int) time.Duration
	Now         func() time.Time
	Send        func(context.Context, notificationdelivery.Record) error
	OnError     func(error)
}

func NewScheduler(options SchedulerOptions) (*Scheduler, error) {
	if options.Store == nil || strings.TrimSpace(options.Owner) == "" || options.Send == nil {
		return nil, errors.New("notification scheduler requires store, owner and sender")
	}
	if options.Lease <= 0 {
		options.Lease = 30 * time.Second
	}
	if options.Every <= 0 {
		options.Every = time.Second
	}
	if options.MaxAttempts <= 0 {
		options.MaxAttempts = 8
	}
	if options.Backoff == nil {
		options.Backoff = func(attempt int) time.Duration {
			delay := time.Second * time.Duration(1<<min(attempt-1, 10))
			if delay > time.Hour {
				return time.Hour
			}
			return delay
		}
	}
	if options.Now == nil {
		options.Now = func() time.Time { return time.Now().UTC() }
	}
	if options.OnError == nil {
		options.OnError = func(error) {}
	}
	return &Scheduler{store: options.Store, owner: options.Owner, lease: options.Lease,
		every: options.Every, maxAttempts: options.MaxAttempts, backoff: options.Backoff,
		now: options.Now, send: options.Send, onError: options.OnError}, nil
}

// RunOnce claims at most one delivery. A send failure is returned after the
// failed/dead state has been persisted, so a caller can count it without
// turning a durable retry into an in-memory retry loop.
func (s *Scheduler) RunOnce(ctx context.Context) (bool, error) {
	now := s.now()
	record, claimed, err := s.store.ClaimNotificationDelivery(ctx, s.owner, now, s.lease)
	if err != nil || !claimed {
		return claimed, err
	}
	if strings.TrimSpace(record.Payload) == "" {
		err = errors.New("notification delivery payload is missing; refusing to send")
	} else {
		err = s.send(ctx, record)
	}
	if err == nil {
		completed, completeErr := record.Complete(s.now())
		if completeErr != nil {
			return true, completeErr
		}
		_, saveErr := s.store.SaveNotificationDelivery(ctx, completed, record.Version)
		return true, saveErr
	}
	reason := err.Error()
	if record.Attempts >= s.maxAttempts {
		dead, deadErr := record.DeadLetter(reason, s.now())
		if deadErr != nil {
			return true, errors.Join(err, deadErr)
		}
		_, saveErr := s.store.SaveNotificationDelivery(ctx, dead, record.Version)
		return true, errors.Join(err, saveErr)
	}
	failureAt := s.now()
	next, retryErr := record.FailAt(reason, failureAt, failureAt.Add(s.backoff(record.Attempts)))
	if retryErr != nil {
		return true, errors.Join(err, retryErr)
	}
	_, saveErr := s.store.SaveNotificationDelivery(ctx, next, record.Version)
	return true, errors.Join(err, saveErr)
}

// Run keeps claiming work until the context is cancelled. Multiple processes
// may run this loop: PostgreSQL's row lock and lease make ownership explicit.
func (s *Scheduler) Run(ctx context.Context) error {
	ticker := time.NewTicker(s.every)
	defer ticker.Stop()
	for {
		_, err := s.RunOnce(ctx)
		if err != nil {
			s.onError(err)
		}
		if err != nil && ctx.Err() != nil {
			return ctx.Err()
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-ticker.C:
		}
	}
}

func min(left, right int) int {
	if left < right {
		return left
	}
	return right
}
