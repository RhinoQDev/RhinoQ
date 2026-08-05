package rulescheduler

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/madebyduy/RhinoQ/internal/domain/rule"
	"github.com/madebyduy/RhinoQ/internal/ports"
)

// The scheduler owns two things worth testing without a database: the timing
// rules that stop a lease expiring under a page that is still running, and what
// it does with a lease after an evaluation succeeds, fails or has more to do.

type fakeScheduleStore struct {
	claim    []rule.ScheduleLease
	claimErr error

	advanced  []string
	completed []rule.ScheduleLease
	failed    []rule.ScheduleLease
	failedFor []time.Duration
	failedWhy []string

	advanceErr, completeErr, failErr error

	lastOwner string
	lastLease time.Duration
	lastLimit int
	claims    int
}

func (s *fakeScheduleStore) ClaimDueRules(
	_ context.Context, owner string, _ time.Time, leaseFor time.Duration, limit int,
) ([]rule.ScheduleLease, error) {
	s.claims++
	s.lastOwner, s.lastLease, s.lastLimit = owner, leaseFor, limit
	return s.claim, s.claimErr
}

func (s *fakeScheduleStore) AdvanceRuleCursor(
	_ context.Context, _ rule.ScheduleLease, cursor string,
) error {
	s.advanced = append(s.advanced, cursor)
	return s.advanceErr
}

func (s *fakeScheduleStore) CompleteRuleRun(
	_ context.Context, lease rule.ScheduleLease,
) error {
	s.completed = append(s.completed, lease)
	return s.completeErr
}

func (s *fakeScheduleStore) FailRuleRun(
	_ context.Context, lease rule.ScheduleLease, retryAfter time.Duration, message string,
) error {
	s.failed = append(s.failed, lease)
	s.failedFor = append(s.failedFor, retryAfter)
	s.failedWhy = append(s.failedWhy, message)
	return s.failErr
}

var _ ports.RuleScheduleStore = (*fakeScheduleStore)(nil)

func lease(id string, version int, cursor string) rule.ScheduleLease {
	return rule.ScheduleLease{RuleID: id, Version: version, Cursor: cursor}
}

func newTestScheduler(t *testing.T, config Config) *Scheduler {
	t.Helper()
	if config.Owner == "" {
		config.Owner = "scheduler-1"
	}
	if config.Now == nil {
		config.Now = func() time.Time { return time.Unix(0, 0).UTC() }
	}
	scheduler, err := New(config)
	if err != nil {
		t.Fatalf("build scheduler: %v", err)
	}
	return scheduler
}

func TestNewRequiresStoreEvaluatorAndOwner(t *testing.T) {
	store := &fakeScheduleStore{}
	evaluate := func(context.Context, string, int, string, string) (rule.Evaluation, error) {
		return rule.Evaluation{}, nil
	}
	for name, config := range map[string]Config{
		"no store":     {Evaluate: evaluate, Owner: "s1"},
		"no evaluator": {Store: store, Owner: "s1"},
		"no owner":     {Store: store, Evaluate: evaluate},
		"blank owner":  {Store: store, Evaluate: evaluate, Owner: "   "},
	} {
		if _, err := New(config); err == nil {
			t.Fatalf("%s must be refused", name)
		}
	}
}

// A lease shorter than the poll interval, or shorter than the longest statement
// a Rule is allowed to run, expires under a page that is still executing — and
// a second scheduler then claims the same page.
func TestNewRefusesTimingThatLetsALeaseExpireMidPage(t *testing.T) {
	store := &fakeScheduleStore{}
	evaluate := func(context.Context, string, int, string, string) (rule.Evaluation, error) {
		return rule.Evaluation{}, nil
	}
	base := Config{Store: store, Evaluate: evaluate, Owner: "s1"}

	shorterThanPoll := base
	shorterThanPoll.PollInterval, shorterThanPoll.Lease = time.Minute, 30*time.Second
	if _, err := New(shorterThanPoll); err == nil {
		t.Fatal("a lease shorter than the poll interval must be refused")
	}

	shorterThanStatement := base
	shorterThanStatement.PollInterval = time.Millisecond
	shorterThanStatement.Lease = rule.MaximumStatementLimit
	if _, err := New(shorterThanStatement); err == nil {
		t.Fatal("a lease no longer than the maximum statement must be refused")
	}

	oversizedBatch := base
	oversizedBatch.ClaimBatch = 101
	if _, err := New(oversizedBatch); err == nil {
		t.Fatal("an unbounded claim batch must be refused")
	}
}

func TestNewFillsSafeDefaults(t *testing.T) {
	scheduler := newTestScheduler(t, Config{
		Store: &fakeScheduleStore{},
		Evaluate: func(context.Context, string, int, string, string) (rule.Evaluation, error) {
			return rule.Evaluation{}, nil
		},
	})
	config := scheduler.config
	if config.PollInterval != time.Second || config.Lease != time.Minute ||
		config.ErrorBackoff != 30*time.Second || config.ClaimBatch != 4 {
		t.Fatalf("defaults must be filled: %+v", config)
	}
	if config.Lease <= config.PollInterval {
		t.Fatal("the defaults themselves must satisfy the timing rule")
	}
}

// A page that filled its limit is not finished. Completing the run instead of
// advancing the cursor would silently skip everything after it — the table
// would be reported clean because nobody looked.
func TestAPartialPageAdvancesTheCursorInsteadOfCompleting(t *testing.T) {
	store := &fakeScheduleStore{claim: []rule.ScheduleLease{lease("orders", 2, "")}}
	scheduler := newTestScheduler(t, Config{
		Store: store,
		Evaluate: func(context.Context, string, int, string, string) (rule.Evaluation, error) {
			return rule.Evaluation{HasMore: true, NextCursor: "order-500"}, nil
		},
	})

	if err := scheduler.RunOnce(context.Background()); err != nil {
		t.Fatal(err)
	}
	if len(store.advanced) != 1 || store.advanced[0] != "order-500" {
		t.Fatalf("a saturated page must advance the cursor: %+v", store.advanced)
	}
	if len(store.completed) != 0 {
		t.Fatal("a page with more to read must not complete the run")
	}
}

func TestAFinishedWalkCompletesTheRun(t *testing.T) {
	store := &fakeScheduleStore{claim: []rule.ScheduleLease{lease("orders", 2, "order-500")}}
	scheduler := newTestScheduler(t, Config{
		Store: store,
		Evaluate: func(context.Context, string, int, string, string) (rule.Evaluation, error) {
			return rule.Evaluation{HasMore: false}, nil
		},
	})

	if err := scheduler.RunOnce(context.Background()); err != nil {
		t.Fatal(err)
	}
	if len(store.completed) != 1 || len(store.advanced) != 0 {
		t.Fatalf("a drained walk completes once: completed=%d advanced=%d",
			len(store.completed), len(store.advanced))
	}
}

// The lease is evaluated at the exact version it names. Drifting to a newer
// draft would evaluate subjects against a Rule the operator has not enabled.
func TestEvaluationUsesTheLeasedVersionAndCursor(t *testing.T) {
	store := &fakeScheduleStore{claim: []rule.ScheduleLease{lease("orders", 7, "order-120")}}
	var gotID, gotSubject, gotCursor string
	var gotVersion int
	scheduler := newTestScheduler(t, Config{
		Store: store,
		Evaluate: func(
			_ context.Context, id string, version int, subjectID, cursor string,
		) (rule.Evaluation, error) {
			gotID, gotVersion, gotSubject, gotCursor = id, version, subjectID, cursor
			return rule.Evaluation{}, nil
		},
	})

	if err := scheduler.RunOnce(context.Background()); err != nil {
		t.Fatal(err)
	}
	if gotID != "orders" || gotVersion != 7 || gotCursor != "order-120" {
		t.Fatalf("the lease identity must be honoured: id=%q version=%d cursor=%q",
			gotID, gotVersion, gotCursor)
	}
	if gotSubject != "" {
		t.Fatalf("a scheduled walk is not a targeted recheck, got subject %q", gotSubject)
	}
}

// A failed evaluation has to release its lease with a backoff. Holding it would
// stall the Rule for the whole lease period on every transient error.
func TestAFailedEvaluationReleasesTheLeaseWithBackoff(t *testing.T) {
	failure := errors.New("statement timeout")
	store := &fakeScheduleStore{claim: []rule.ScheduleLease{lease("orders", 2, "")}}
	scheduler := newTestScheduler(t, Config{
		Store: store, ErrorBackoff: 90 * time.Second,
		Evaluate: func(context.Context, string, int, string, string) (rule.Evaluation, error) {
			return rule.Evaluation{}, failure
		},
	})

	err := scheduler.RunOnce(context.Background())
	if !errors.Is(err, failure) {
		t.Fatalf("the evaluation error must reach the caller, got %v", err)
	}
	if len(store.failed) != 1 || store.failedFor[0] != 90*time.Second {
		t.Fatalf("the lease must be released with the configured backoff: %+v", store.failedFor)
	}
	if store.failedWhy[0] != "statement timeout" {
		t.Fatalf("the reason must be recorded for the operator: %q", store.failedWhy[0])
	}
	if len(store.completed) != 0 || len(store.advanced) != 0 {
		t.Fatal("a failed evaluation must not advance or complete anything")
	}
}

// If releasing the lease also fails, both errors matter: one explains the Rule,
// the other explains why it will stay stuck until the lease expires.
func TestBothErrorsSurviveWhenTheReleaseAlsoFails(t *testing.T) {
	evaluationErr := errors.New("statement timeout")
	releaseErr := errors.New("database unavailable")
	store := &fakeScheduleStore{
		claim:   []rule.ScheduleLease{lease("orders", 2, "")},
		failErr: releaseErr,
	}
	scheduler := newTestScheduler(t, Config{
		Store: store,
		Evaluate: func(context.Context, string, int, string, string) (rule.Evaluation, error) {
			return rule.Evaluation{}, evaluationErr
		},
	})

	err := scheduler.RunOnce(context.Background())
	if !errors.Is(err, evaluationErr) || !errors.Is(err, releaseErr) {
		t.Fatalf("both failures must be reported, got %v", err)
	}
}

// One broken Rule must not stop the other Rules claimed in the same cycle.
func TestOneFailingRuleDoesNotStopTheBatch(t *testing.T) {
	failure := errors.New("bad query")
	store := &fakeScheduleStore{claim: []rule.ScheduleLease{
		lease("orders", 1, ""), lease("refunds", 1, ""), lease("reports", 1, ""),
	}}
	scheduler := newTestScheduler(t, Config{
		Store: store,
		Evaluate: func(
			_ context.Context, id string, _ int, _, _ string,
		) (rule.Evaluation, error) {
			if id == "refunds" {
				return rule.Evaluation{}, failure
			}
			return rule.Evaluation{}, nil
		},
	})

	err := scheduler.RunOnce(context.Background())
	if !errors.Is(err, failure) {
		t.Fatalf("the failure must still be reported, got %v", err)
	}
	if len(store.completed) != 2 {
		t.Fatalf("the healthy Rules must still run: %d completed", len(store.completed))
	}
	if len(store.failed) != 1 {
		t.Fatalf("only the broken Rule is released with backoff: %d", len(store.failed))
	}
}

func TestClaimFailureIsReportedAndEvaluatesNothing(t *testing.T) {
	failure := errors.New("database unavailable")
	store := &fakeScheduleStore{claimErr: failure}
	calls := 0
	scheduler := newTestScheduler(t, Config{
		Store: store,
		Evaluate: func(context.Context, string, int, string, string) (rule.Evaluation, error) {
			calls++
			return rule.Evaluation{}, nil
		},
	})

	if err := scheduler.RunOnce(context.Background()); !errors.Is(err, failure) {
		t.Fatalf("a claim failure must reach the caller, got %v", err)
	}
	if calls != 0 {
		t.Fatalf("nothing may be evaluated without a lease, got %d calls", calls)
	}
}

// The owner and the claim bounds are what keep two schedulers off the same page.
func TestClaimCarriesTheOwnerAndItsBounds(t *testing.T) {
	store := &fakeScheduleStore{}
	scheduler := newTestScheduler(t, Config{
		Store: store, Owner: "scheduler-b", Lease: 2 * time.Minute, ClaimBatch: 9,
		Evaluate: func(context.Context, string, int, string, string) (rule.Evaluation, error) {
			return rule.Evaluation{}, nil
		},
	})

	if err := scheduler.RunOnce(context.Background()); err != nil {
		t.Fatal(err)
	}
	if store.lastOwner != "scheduler-b" || store.lastLease != 2*time.Minute ||
		store.lastLimit != 9 {
		t.Fatalf("the claim must carry owner and bounds: owner=%q lease=%s limit=%d",
			store.lastOwner, store.lastLease, store.lastLimit)
	}
}

// Run must return on cancellation rather than polling forever, and must not
// surface the cancellation as a scheduling error.
func TestRunStopsOnCancellationWithoutReportingAnError(t *testing.T) {
	store := &fakeScheduleStore{}
	var observed []error
	scheduler := newTestScheduler(t, Config{
		Store: store, PollInterval: time.Millisecond, Lease: time.Minute,
		Evaluate: func(context.Context, string, int, string, string) (rule.Evaluation, error) {
			return rule.Evaluation{}, nil
		},
		OnError: func(err error) { observed = append(observed, err) },
	})

	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := scheduler.Run(ctx); err != nil {
		t.Fatalf("a cancelled scheduler stops cleanly, got %v", err)
	}
	if len(observed) != 0 {
		t.Fatalf("shutdown is not an error to page anyone about: %v", observed)
	}
}
