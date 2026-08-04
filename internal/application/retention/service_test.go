package retention

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/madebyduy/RhinoQ/internal/ports"
)

type recordingStore struct {
	plans, prunes int
	lastCutoff    time.Time
	lastRule      string
	lastBatch     int
	err           error
}

func (s *recordingStore) PlanRetention(
	_ context.Context, cutoff time.Time, ruleID string,
) (ports.RetentionPlan, error) {
	s.plans++
	s.lastCutoff, s.lastRule = cutoff, ruleID
	return ports.RetentionPlan{
		Cutoff: cutoff,
		Targets: []ports.RetentionTarget{
			{Table: "rhinoq_subject_outcomes", What: "passing observations", Rows: 12},
			{Table: "rhinoq_finding_events", What: "resolved history", Rows: 3},
		},
	}, s.err
}

func (s *recordingStore) PruneRetention(
	_ context.Context, cutoff time.Time, ruleID string, batch int,
) (ports.RetentionPlan, error) {
	s.prunes++
	s.lastCutoff, s.lastRule, s.lastBatch = cutoff, ruleID, batch
	return ports.RetentionPlan{
		Cutoff:  cutoff,
		Targets: []ports.RetentionTarget{{Table: "rhinoq_subject_outcomes", Rows: 12}},
	}, s.err
}

var _ ports.RetentionStore = (*recordingStore)(nil)

func newService(t *testing.T, store ports.RetentionStore, now time.Time) *Service {
	t.Helper()
	service, err := New(store, func() time.Time { return now })
	if err != nil {
		t.Fatalf("build service: %v", err)
	}
	return service
}

// The default has to be preview. Retention is the one command whose mistake is
// unrecoverable, so it must behave like rhinoq rules delete rather than like a
// command that acts because it was typed.
func TestPruneWithoutApplyDeletesNothing(t *testing.T) {
	store := &recordingStore{}
	now := time.Date(2026, 8, 4, 0, 0, 0, 0, time.UTC)
	service := newService(t, store, now)

	result, err := service.Prune(context.Background(), Request{OlderThan: 90 * 24 * time.Hour})
	if err != nil {
		t.Fatal(err)
	}
	if store.prunes != 0 || store.plans != 1 {
		t.Fatalf("preview must plan and never prune: plans=%d prunes=%d", store.plans, store.prunes)
	}
	if result.Applied {
		t.Fatal("a preview must not report itself as applied")
	}
	if result.Plan.Total() != 15 {
		t.Fatalf("the plan must total every target: %d", result.Plan.Total())
	}
	if want := now.Add(-90 * 24 * time.Hour); !store.lastCutoff.Equal(want) {
		t.Fatalf("cutoff must be now minus the age: got %s want %s", store.lastCutoff, want)
	}
}

func TestPruneWithApplyDeletesInBatches(t *testing.T) {
	store := &recordingStore{}
	service := newService(t, store, time.Date(2026, 8, 4, 0, 0, 0, 0, time.UTC))

	result, err := service.Prune(context.Background(), Request{
		OlderThan: 30 * 24 * time.Hour, RuleID: " orders-provisioned ", Apply: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	if store.plans != 0 || store.prunes != 1 {
		t.Fatalf("apply prunes directly: plans=%d prunes=%d", store.plans, store.prunes)
	}
	if !result.Applied {
		t.Fatal("a completed prune reports itself as applied")
	}
	if store.lastBatch != DefaultBatch {
		t.Fatalf("an unset batch uses the bounded default, got %d", store.lastBatch)
	}
	if store.lastRule != "orders-provisioned" {
		t.Fatalf("the rule filter must be trimmed, got %q", store.lastRule)
	}
}

// A mistyped age is the failure this guard exists for: deleting evidence of an
// incident that is still open cannot be undone.
func TestPruneRefusesACutoffYoungerThanADay(t *testing.T) {
	store := &recordingStore{}
	service := newService(t, store, time.Now())

	for _, age := range []time.Duration{0, time.Minute, MinimumAge - time.Second} {
		if _, err := service.Prune(context.Background(), Request{OlderThan: age, Apply: true}); err == nil {
			t.Fatalf("age %s must be refused", age)
		}
	}
	if store.plans != 0 || store.prunes != 0 {
		t.Fatalf("a refused request must not reach the store: %+v", store)
	}
}

func TestPruneRejectsAnUnboundedBatch(t *testing.T) {
	store := &recordingStore{}
	service := newService(t, store, time.Now())

	for _, batch := range []int{-1, 100001} {
		if _, err := service.Prune(context.Background(), Request{
			OlderThan: 90 * 24 * time.Hour, Batch: batch, Apply: true,
		}); err == nil {
			t.Fatalf("batch %d must be refused", batch)
		}
	}
	if store.prunes != 0 {
		t.Fatalf("a refused batch must not delete anything, got %d prunes", store.prunes)
	}
}

// A prune that stops early reports what it removed. The next run resumes, so a
// partial result is a result rather than a failure to hide.
func TestPartialPruneKeepsWhatItRemoved(t *testing.T) {
	failure := errors.New("context deadline exceeded")
	store := &recordingStore{err: failure}
	service := newService(t, store, time.Now())

	result, err := service.Prune(context.Background(), Request{
		OlderThan: 90 * 24 * time.Hour, Apply: true,
	})
	if !errors.Is(err, failure) {
		t.Fatalf("the store error must reach the caller, got %v", err)
	}
	if result.Applied {
		t.Fatal("an interrupted prune is not a completed one")
	}
	if result.Plan.Total() != 12 {
		t.Fatalf("the rows already removed must still be reported: %d", result.Plan.Total())
	}
}

func TestNewRequiresAStore(t *testing.T) {
	if _, err := New(nil, nil); err == nil {
		t.Fatal("a retention service without a store must not build")
	}
}
