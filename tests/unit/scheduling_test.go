package unit

import (
	"errors"
	"testing"
	"time"

	"github.com/madebyduy/RhinoQ/internal/domain/job"
)

func TestEffectivePriorityAgesWaitingWorkWithinACap(t *testing.T) {
	now := time.Date(2026, 7, 27, 12, 0, 0, 0, time.UTC)

	if got := job.EffectivePriority(5, now, now); got != 5 {
		t.Fatalf("fresh work keeps its declared priority, got %v", got)
	}
	if got := job.EffectivePriority(0, now.Add(-2*time.Hour), now); got != 2 {
		t.Fatalf("two hours of waiting should add two points, got %v", got)
	}
	if got := job.EffectivePriority(0, now.Add(-100*time.Hour), now); got != job.MaxAgingBoost {
		t.Fatalf("aging must be capped at %v, got %v", job.MaxAgingBoost, got)
	}
	// The cap is what keeps aging from inverting a real priority decision.
	aged := job.EffectivePriority(0, now.Add(-1000*time.Hour), now)
	if aged >= job.EffectivePriority(10, now, now) {
		t.Fatalf("aged batch work must not overtake fresh high priority work: %v", aged)
	}
}

func TestJobClassNormalisesAndRejectsUnknownValues(t *testing.T) {
	class, err := job.NormalizeClass("")
	if err != nil || class != job.Standard {
		t.Fatalf("an unset class must resolve to standard: %v %v", class, err)
	}
	if _, err := job.NormalizeClass("urgent"); !errors.Is(err, job.ErrInvalidClass) {
		t.Fatalf("an unknown class must be rejected, got %v", err)
	}
	if !job.Critical.IsCritical() || job.Batch.IsCritical() {
		t.Fatal("only the critical class may draw on the reserved budget")
	}
}

func TestProtectionUsesADefaultCrashBudget(t *testing.T) {
	protection := job.Protection{}.Normalize()
	if protection.MaxWorkerCrashesPerJob != job.DefaultMaxWorkerCrashesPerJob {
		t.Fatalf("unset protection must fall back to the default budget: %+v", protection)
	}
	budget := job.Protection{MaxWorkerCrashesPerJob: 3}
	if budget.IsPoisoned(2) {
		t.Fatal("a job below its crash budget must keep being retried")
	}
	if !budget.IsPoisoned(3) {
		t.Fatal("a job at its crash budget must be parked")
	}
}
