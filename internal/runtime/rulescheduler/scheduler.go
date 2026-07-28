// Package rulescheduler runs enabled table-scoped Rules from durable,
// lease-fenced cursors. Each claim evaluates one bounded page so Rules cannot
// monopolise the database.
package rulescheduler

import (
	"context"
	"errors"
	"strings"
	"time"

	"github.com/rhinoq/rhinoq/internal/domain/rule"
	"github.com/rhinoq/rhinoq/internal/ports"
)

type EvaluateFunc func(
	ctx context.Context, id string, version int, subjectID, cursor string,
) (rule.Evaluation, error)

type Config struct {
	Store        ports.RuleScheduleStore
	Evaluate     EvaluateFunc
	Owner        string
	PollInterval time.Duration
	Lease        time.Duration
	ErrorBackoff time.Duration
	ClaimBatch   int
	Now          func() time.Time
	OnError      func(error)
}

type Scheduler struct {
	config Config
}

func New(config Config) (*Scheduler, error) {
	if config.Store == nil || config.Evaluate == nil ||
		strings.TrimSpace(config.Owner) == "" {
		return nil, errors.New("rule scheduler requires store, evaluator and owner")
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
		config.ClaimBatch = 4
	}
	if config.ClaimBatch > 100 || config.Lease <= config.PollInterval ||
		config.Lease <= rule.MaximumStatementLimit {
		return nil, errors.New("invalid rule scheduler timing or claim batch")
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

// RunOnce claims and evaluates at most ClaimBatch bounded pages.
func (s *Scheduler) RunOnce(ctx context.Context) error {
	now := s.config.Now()
	leases, err := s.config.Store.ClaimDueRules(
		ctx, s.config.Owner, now, s.config.Lease, s.config.ClaimBatch,
	)
	if err != nil {
		return err
	}
	var combined error
	for _, lease := range leases {
		if err := s.evaluateLease(ctx, lease); err != nil {
			combined = errors.Join(combined, err)
		}
	}
	return combined
}

func (s *Scheduler) evaluateLease(
	ctx context.Context,
	lease rule.ScheduleLease,
) error {
	evaluation, err := s.config.Evaluate(
		ctx, lease.RuleID, lease.Version, "", lease.Cursor,
	)
	if err != nil {
		if releaseErr := s.config.Store.FailRuleRun(
			ctx, lease, s.config.ErrorBackoff, err.Error(),
		); releaseErr != nil {
			return errors.Join(err, releaseErr)
		}
		return err
	}
	if evaluation.HasMore {
		return s.config.Store.AdvanceRuleCursor(
			ctx, lease, evaluation.NextCursor,
		)
	}
	return s.config.Store.CompleteRuleRun(ctx, lease)
}
