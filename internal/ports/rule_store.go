package ports

import (
	"context"
	"time"

	"github.com/madebyduy/RhinoQ/internal/domain/rule"
)

type RuleStore interface {
	SaveRule(ctx context.Context, record rule.Record) (rule.Record, error)
	GetRule(ctx context.Context, id string) (rule.Record, bool, error)
	GetRuleVersion(ctx context.Context, id string, version int) (rule.Record, bool, error)
	ListRules(ctx context.Context, query rule.Query) ([]rule.Record, error)
	SetRuleStatus(ctx context.Context, id string, version int, status rule.Status, at time.Time) (rule.Record, error)
	SaveRuleExplanation(ctx context.Context, id string, version int, explanation rule.Explanation) error
	GetRuleExplanation(ctx context.Context, id string, version int) (rule.Explanation, bool, error)
	// DeleteRule removes a Rule definition and everything derived from it -
	// explanations, schedules, subject outcomes and, when the caller asked for
	// it, Findings and their history - as one atomic unit. A Rule spans several
	// tables, so a half-finished delete leaves an evaluation cursor or a
	// Finding pointing at a definition nobody can read any more.
	//
	// A DryRun request performs the same deletion and rolls it back, so the
	// plan an operator reviews is produced by the code that would do the work
	// rather than by a second query that can disagree with it.
	DeleteRule(ctx context.Context, request rule.DeleteRequest) (rule.Deletion, error)
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
