package lease

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/madebyduy/RhinoQ/internal/domain/job"
	"github.com/madebyduy/RhinoQ/internal/ports"
)

// The reaper is what makes a crashed worker recoverable, and everything it does
// is bounded on purpose. These tests hold the bounds in place: a mass expiry —
// a deploy that killed every worker at once — is exactly the case where an
// unbounded sweep would stall the database it is trying to rescue.

// The embedded interfaces are left nil on purpose. The reaper is only allowed
// to call RequeueExpired and MarkPendingUncertain, so any other method panics
// rather than quietly doing nothing — a sweep that started claiming or
// completing jobs would pass a test that stubbed those out.
type fakeJobStore struct {
	ports.JobStore

	batches []ports.ReapResult
	calls   int
	limits  []int
	err     error
}

func (s *fakeJobStore) RequeueExpired(
	_ context.Context, input ports.ReapInput,
) (ports.ReapResult, error) {
	s.calls++
	s.limits = append(s.limits, input.Limit)
	if s.err != nil {
		return ports.ReapResult{}, s.err
	}
	if s.calls > len(s.batches) {
		return ports.ReapResult{}, nil
	}
	return s.batches[s.calls-1], nil
}

type fakeEffectStore struct {
	ports.EffectStore

	seen  []ports.ExpiredLease
	calls int
	err   error
}

func (s *fakeEffectStore) MarkPendingUncertain(
	_ context.Context, expired []ports.ExpiredLease,
) (int, error) {
	s.calls++
	s.seen = append(s.seen, expired...)
	return len(expired), s.err
}

func saturated(requeued int, ids ...string) ports.ReapResult {
	result := ports.ReapResult{Requeued: requeued, Saturated: true}
	for index, id := range ids {
		result.Expired = append(result.Expired, ports.ExpiredLease{
			JobID: ports.JobID(id), Epoch: int64(index + 1),
		})
	}
	return result
}

func final(requeued, blocked int, ids ...string) ports.ReapResult {
	result := saturated(requeued, ids...)
	result.Blocked = blocked
	result.Saturated = false
	return result
}

func newTestReaper(t *testing.T, config Config) *Reaper {
	t.Helper()
	if config.Interval == 0 {
		config.Interval = time.Minute
	}
	if config.Now == nil {
		config.Now = func() time.Time { return time.Unix(0, 0).UTC() }
	}
	reaper, err := NewReaper(config)
	if err != nil {
		t.Fatalf("build reaper: %v", err)
	}
	return reaper
}

func TestNewReaperRequiresStoreIntervalAndClock(t *testing.T) {
	store := &fakeJobStore{}
	now := func() time.Time { return time.Unix(0, 0) }
	for name, config := range map[string]Config{
		"no store":    {Interval: time.Minute, Now: now},
		"no interval": {Store: store, Now: now},
		"no clock":    {Store: store, Interval: time.Minute},
		"negative interval": {
			Store: store, Interval: -time.Second, Now: now,
		},
	} {
		if _, err := NewReaper(config); err == nil {
			t.Fatalf("%s must be refused: a reaper that cannot sweep is worse than none", name)
		}
	}
}

// A backlog larger than one batch must keep draining, because a single
// statement over every expired lease is the thing batching exists to avoid.
func TestSweepDrainsUntilTheBacklogIsEmpty(t *testing.T) {
	store := &fakeJobStore{batches: []ports.ReapResult{
		saturated(2, "job-1", "job-2"),
		saturated(2, "job-3", "job-4"),
		final(1, 0, "job-5"),
	}}
	reaper := newTestReaper(t, Config{Store: store})

	result, err := reaper.Sweep(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if store.calls != 3 {
		t.Fatalf("a saturated batch must be followed by another, got %d calls", store.calls)
	}
	if result.Requeued != 5 || len(result.Expired) != 5 {
		t.Fatalf("the sweep must total every batch: %+v", result)
	}
	if result.Saturated {
		t.Fatal("a drained backlog is not saturated")
	}
}

// The budget is what stops a mass expiry turning the reaper into an unbounded
// loop competing with live claims for the same rows.
func TestSweepStopsOnItsBudgetAndSaysSo(t *testing.T) {
	clock := time.Unix(0, 0).UTC()
	store := &fakeJobStore{batches: []ports.ReapResult{
		saturated(2, "job-1"),
		saturated(2, "job-2"),
		saturated(2, "job-3"),
	}}
	reaper := newTestReaper(t, Config{
		Store: store, Interval: time.Minute, SweepBudget: 10 * time.Second,
		Now: func() time.Time {
			// Every read advances the clock, so the budget runs out mid-drain.
			clock = clock.Add(6 * time.Second)
			return clock
		},
	})

	result, err := reaper.Sweep(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if !result.Saturated {
		t.Fatalf("a sweep that gave up must report it: %+v", result)
	}
	if store.calls >= 3 {
		t.Fatalf("the budget must cut the drain short, got %d calls", store.calls)
	}
}

// An effect that was in flight when its worker died has an unknown result. The
// epoch bound is what makes downgrading it safe once the job is claimed again.
func TestSweepDowngradesEffectsOfDeadExecutions(t *testing.T) {
	store := &fakeJobStore{batches: []ports.ReapResult{final(2, 0, "job-1", "job-2")}}
	effects := &fakeEffectStore{}
	reaper := newTestReaper(t, Config{Store: store, Effects: effects})

	if _, err := reaper.Sweep(context.Background()); err != nil {
		t.Fatal(err)
	}
	if effects.calls != 1 || len(effects.seen) != 2 {
		t.Fatalf("every expired lease must reach the effect ledger: %+v", effects)
	}
	if effects.seen[0].Epoch == 0 {
		t.Fatal("the epoch must travel with the expired lease or the downgrade is unbounded")
	}
}

func TestSweepSkipsTheEffectLedgerWhenNothingExpired(t *testing.T) {
	store := &fakeJobStore{batches: []ports.ReapResult{final(0, 0)}}
	effects := &fakeEffectStore{}
	reaper := newTestReaper(t, Config{Store: store, Effects: effects})

	if _, err := reaper.Sweep(context.Background()); err != nil {
		t.Fatal(err)
	}
	if effects.calls != 0 {
		t.Fatalf("an empty sweep must not write to the ledger, got %d calls", effects.calls)
	}
}

// A failing ledger must not be swallowed. Reporting the requeue as complete
// while effects stay pending is how a duplicate charge gets retried.
func TestSweepReportsAnEffectLedgerFailure(t *testing.T) {
	failure := errors.New("ledger unavailable")
	store := &fakeJobStore{batches: []ports.ReapResult{final(1, 0, "job-1")}}
	effects := &fakeEffectStore{err: failure}
	reaper := newTestReaper(t, Config{Store: store, Effects: effects})

	if _, err := reaper.Sweep(context.Background()); !errors.Is(err, failure) {
		t.Fatalf("the ledger error must reach the caller, got %v", err)
	}
}

func TestSweepReportsAStoreFailure(t *testing.T) {
	failure := errors.New("database unavailable")
	reaper := newTestReaper(t, Config{Store: &fakeJobStore{err: failure}})

	if _, err := reaper.Sweep(context.Background()); !errors.Is(err, failure) {
		t.Fatalf("the store error must reach the caller, got %v", err)
	}
}

// Parking a poison job is the event an operator most needs to hear about, so it
// must reach Observe rather than only appear in a queue view later.
func TestObserveSeesRequeuedAndBlockedBatches(t *testing.T) {
	store := &fakeJobStore{batches: []ports.ReapResult{
		saturated(3, "job-1"),
		final(0, 2, "job-2"),
	}}
	var seen []ports.ReapResult
	reaper := newTestReaper(t, Config{
		Store:   store,
		Observe: func(result ports.ReapResult) { seen = append(seen, result) },
	})

	if _, err := reaper.Sweep(context.Background()); err != nil {
		t.Fatal(err)
	}
	if len(seen) != 2 {
		t.Fatalf("every batch that moved something must be observed: %+v", seen)
	}
	if seen[1].Blocked != 2 {
		t.Fatalf("a parked poison job must be reported: %+v", seen[1])
	}
}

func TestObserveIsSilentWhenNothingMoved(t *testing.T) {
	store := &fakeJobStore{batches: []ports.ReapResult{final(0, 0)}}
	calls := 0
	reaper := newTestReaper(t, Config{
		Store:   store,
		Observe: func(ports.ReapResult) { calls++ },
	})

	if _, err := reaper.Sweep(context.Background()); err != nil {
		t.Fatal(err)
	}
	if calls != 0 {
		t.Fatalf("an idle sweep must not page anyone, got %d observations", calls)
	}
}

// The batch limit is a database safety bound, so a caller must not be able to
// widen it past what one statement is allowed to touch.
func TestBatchLimitIsClampedToTheSupportedRange(t *testing.T) {
	for name, testCase := range map[string]struct {
		configured, want int
	}{
		"unset uses the default": {0, ports.DefaultReapBatchLimit},
		"negative is refused":    {-1, ports.DefaultReapBatchLimit},
		"oversized is clamped":   {ports.MaxReapBatchLimit + 5000, ports.MaxReapBatchLimit},
		"in range is kept":       {250, 250},
	} {
		t.Run(name, func(t *testing.T) {
			store := &fakeJobStore{batches: []ports.ReapResult{final(0, 0)}}
			reaper := newTestReaper(t, Config{Store: store, BatchLimit: testCase.configured})
			if _, err := reaper.Sweep(context.Background()); err != nil {
				t.Fatal(err)
			}
			if store.limits[0] != testCase.want {
				t.Fatalf("limit: got %d want %d", store.limits[0], testCase.want)
			}
		})
	}
}

// An unset protection must not mean "never park", which would let one poison
// job take down every worker in turn forever.
func TestProtectionDefaultsRatherThanDisabling(t *testing.T) {
	reaper := newTestReaper(t, Config{Store: &fakeJobStore{}})
	if reaper.protection.MaxWorkerCrashesPerJob != job.DefaultMaxWorkerCrashesPerJob {
		t.Fatalf("unset protection must default, got %+v", reaper.protection)
	}
}

// The budget defaults to half the interval so a sweep always finishes before
// the next tick starts.
func TestSweepBudgetDefaultsToHalfTheInterval(t *testing.T) {
	reaper := newTestReaper(t, Config{Store: &fakeJobStore{}, Interval: time.Minute})
	if reaper.budget != 30*time.Second {
		t.Fatalf("budget: got %s want 30s", reaper.budget)
	}
}

func TestRunRequiresAContext(t *testing.T) {
	reaper := newTestReaper(t, Config{Store: &fakeJobStore{}})
	//lint:ignore SA1012 the nil context is the input under test
	if err := reaper.Run(nil); err == nil { //nolint:staticcheck
		t.Fatal("Run without a context must be refused rather than panic later")
	}
}

// Run must return when its context is cancelled instead of ticking forever.
func TestRunStopsOnCancellation(t *testing.T) {
	store := &fakeJobStore{batches: []ports.ReapResult{final(0, 0)}}
	reaper := newTestReaper(t, Config{Store: store, Interval: time.Hour})
	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	if err := reaper.Run(ctx); !errors.Is(err, context.Canceled) {
		t.Fatalf("a cancelled reaper must report why it stopped, got %v", err)
	}
	if store.calls != 1 {
		t.Fatalf("Run sweeps once before waiting, got %d calls", store.calls)
	}
}

var (
	_ ports.JobStore    = (*fakeJobStore)(nil)
	_ ports.EffectStore = (*fakeEffectStore)(nil)
)
