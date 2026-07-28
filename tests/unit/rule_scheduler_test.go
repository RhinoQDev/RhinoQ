package unit

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/rhinoq/rhinoq/internal/adapters/memory"
	"github.com/rhinoq/rhinoq/internal/domain/rule"
	"github.com/rhinoq/rhinoq/internal/runtime/rulescheduler"
)

type schedulerEvaluator struct {
	cursors  []string
	versions []int
	fail     error
}

func (e *schedulerEvaluator) Evaluate(
	_ context.Context, _ string, version int, _, cursor string,
) (rule.Evaluation, error) {
	e.cursors = append(e.cursors, cursor)
	e.versions = append(e.versions, version)
	if e.fail != nil {
		return rule.Evaluation{}, e.fail
	}
	if cursor == "" {
		return rule.Evaluation{NextCursor: "report-0500", HasMore: true}, nil
	}
	return rule.Evaluation{NextCursor: "report-0750", HasMore: false}, nil
}

func TestRuleSchedulerPersistsCursorBetweenBoundedClaims(t *testing.T) {
	store := memory.NewRuleStore()
	now := time.Date(2026, 7, 28, 8, 0, 0, 0, time.UTC)
	saveEnabledTableRule(t, store, now)
	evaluator := &schedulerEvaluator{}
	clock := now
	scheduler, err := rulescheduler.New(rulescheduler.Config{
		Store: store, Evaluate: evaluator.Evaluate, Owner: "scheduler-a",
		PollInterval: time.Second, Lease: time.Minute, ClaimBatch: 1,
		Now: func() time.Time { return clock },
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := scheduler.RunOnce(context.Background()); err != nil {
		t.Fatal(err)
	}
	if err := scheduler.RunOnce(context.Background()); err != nil {
		t.Fatal(err)
	}
	if len(evaluator.cursors) != 2 ||
		evaluator.cursors[0] != "" || evaluator.cursors[1] != "report-0500" {
		t.Fatalf("scheduler must resume the persisted page cursor: %v", evaluator.cursors)
	}
	if evaluator.versions[0] != 1 || evaluator.versions[1] != 1 {
		t.Fatalf("scheduler must evaluate the immutable leased version: %v", evaluator.versions)
	}
	clock = clock.Add(9 * time.Minute)
	if err := scheduler.RunOnce(context.Background()); err != nil {
		t.Fatal(err)
	}
	if len(evaluator.cursors) != 2 {
		t.Fatalf("completed rule must wait for its interval: %v", evaluator.cursors)
	}
	clock = clock.Add(time.Minute)
	if err := scheduler.RunOnce(context.Background()); err != nil {
		t.Fatal(err)
	}
	if evaluator.cursors[2] != "" {
		t.Fatalf("a new full scan must restart at the baseline: %v", evaluator.cursors)
	}
}

func TestRuleSchedulerReleasesFailedPageWithBackoff(t *testing.T) {
	store := memory.NewRuleStore()
	now := time.Date(2026, 7, 28, 8, 0, 0, 0, time.UTC)
	saveEnabledTableRule(t, store, now)
	evaluator := &schedulerEvaluator{fail: errors.New("database unavailable")}
	clock := now
	scheduler, err := rulescheduler.New(rulescheduler.Config{
		Store: store, Evaluate: evaluator.Evaluate, Owner: "scheduler-a",
		PollInterval: time.Second, Lease: time.Minute,
		ErrorBackoff: 30 * time.Second, ClaimBatch: 1,
		Now: func() time.Time { return clock },
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := scheduler.RunOnce(context.Background()); err == nil {
		t.Fatal("evaluation failure must be observable")
	}
	clock = clock.Add(29 * time.Second)
	_ = scheduler.RunOnce(context.Background())
	if len(evaluator.cursors) != 1 {
		t.Fatalf("failed rule must honor backoff: calls=%d", len(evaluator.cursors))
	}
	clock = clock.Add(time.Second)
	_ = scheduler.RunOnce(context.Background())
	if len(evaluator.cursors) != 2 {
		t.Fatalf("failed rule must become claimable after backoff: calls=%d", len(evaluator.cursors))
	}
}

func TestDisablingRuleStopsFutureClaimsWithoutCancellingInflightPage(t *testing.T) {
	store := memory.NewRuleStore()
	now := time.Date(2026, 7, 28, 8, 0, 0, 0, time.UTC)
	saveEnabledTableRule(t, store, now)
	leases, err := store.ClaimDueRules(
		context.Background(), "scheduler-a", now, time.Minute, 1,
	)
	if err != nil || len(leases) != 1 {
		t.Fatalf("claim enabled Rule: leases=%+v err=%v", leases, err)
	}
	if _, err := store.SetRuleStatus(
		context.Background(), leases[0].RuleID, leases[0].Version,
		rule.Disabled, now.Add(time.Second),
	); err != nil {
		t.Fatal(err)
	}
	if err := store.CompleteRuleRun(context.Background(), leases[0]); err != nil {
		t.Fatalf("an in-flight page claimed while enabled may finish: %v", err)
	}
	next, err := store.ClaimDueRules(
		context.Background(), "scheduler-b", now.Add(time.Hour), time.Minute, 1,
	)
	if err != nil || len(next) != 0 {
		t.Fatalf("disabled Rule must not be claimed again: leases=%+v err=%v", next, err)
	}
}

func saveEnabledTableRule(t *testing.T, store *memory.RuleStore, now time.Time) {
	t.Helper()
	_, err := store.SaveRule(context.Background(), rule.Record{
		ID: "report-output-exists", Version: 1, Name: "Report output exists",
		Scope: rule.TableScope, Status: rule.Enabled, SubjectType: "report",
		Query: `SELECT id::text AS subject_id, true AS violated,
			'{}'::jsonb AS evidence FROM reports
			WHERE created_at >= $1 AND id::text > $2
			ORDER BY id::text LIMIT $3`,
		BaselineAt: now, Every: 10 * time.Minute,
		CreatedAt: now, UpdatedAt: now,
	})
	if err != nil {
		t.Fatal(err)
	}
}
