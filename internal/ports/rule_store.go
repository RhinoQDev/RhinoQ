package ports

import (
	"context"
	"time"

	"github.com/rhinoq/rhinoq/internal/domain/rule"
)

type RuleStore interface {
	SaveRule(ctx context.Context, record rule.Record) (rule.Record, error)
	GetRule(ctx context.Context, id string) (rule.Record, bool, error)
	ListRules(ctx context.Context, query rule.Query) ([]rule.Record, error)
	SetRuleStatus(ctx context.Context, id string, version int, status rule.Status, at time.Time) (rule.Record, error)
	SaveRuleExplanation(ctx context.Context, id string, version int, explanation rule.Explanation) error
	GetRuleExplanation(ctx context.Context, id string, version int) (rule.Explanation, bool, error)
}

type RuleExplainer interface {
	ExplainRule(ctx context.Context, record rule.Record) (rule.Explanation, error)
}

type RuleEvaluator interface {
	EvaluateRule(ctx context.Context, record rule.Record, subjectID, cursor string) (rule.Evaluation, error)
}

// RuleScheduleStore owns durable scheduler cursors and fenced run leases.
// Advancing and completing require the exact owner/epoch returned by Claim.
type RuleScheduleStore interface {
	ClaimDueRules(ctx context.Context, owner string, now time.Time, leaseFor time.Duration, limit int) ([]rule.ScheduleLease, error)
	AdvanceRuleCursor(ctx context.Context, lease rule.ScheduleLease, cursor string) error
	CompleteRuleRun(ctx context.Context, lease rule.ScheduleLease) error
	FailRuleRun(ctx context.Context, lease rule.ScheduleLease, retryAfter time.Duration, message string) error
}
