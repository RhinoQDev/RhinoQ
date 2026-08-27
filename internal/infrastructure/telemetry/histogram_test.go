package telemetry

import (
	"strings"
	"sync"
	"testing"
	"time"
)

func TestObservePlacesValuesInUpperInclusiveBuckets(t *testing.T) {
	h := NewHistogram([]float64{1, 2, 5})
	// Exactly on a boundary belongs to that boundary's bucket: Prometheus
	// buckets are le, not lt. Getting this wrong shifts every round number one
	// bucket right and quietly inflates every percentile.
	for _, value := range []float64{0.5, 1, 1.5, 2, 4.9, 5, 5.1, 100} {
		h.Observe(value)
	}
	snapshot := h.Snapshot()
	// le=1 holds 0.5 and 1; le=2 adds 1.5 and 2; le=5 adds 4.9 and 5; +Inf adds
	// 5.1 and 100.
	want := []uint64{2, 4, 6, 8}
	for i, expected := range want {
		if snapshot.Cumulative[i] != expected {
			t.Errorf("cumulative[%d] = %d, want %d (bounds %v)", i, snapshot.Cumulative[i], expected, snapshot.Bounds)
		}
	}
	if snapshot.Count != 8 {
		t.Errorf("count = %d, want 8", snapshot.Count)
	}
	if snapshot.Sum < 119.9 || snapshot.Sum > 120.1 {
		t.Errorf("sum = %v, want ~120", snapshot.Sum)
	}
}

// The +Inf bucket must equal the observation count. A histogram whose last
// cumulative bucket is below _count is treated as corrupt, not as approximate.
func TestFinalBucketEqualsCount(t *testing.T) {
	h := NewHistogram(TaskLatencyBuckets)
	for i := 0; i < 50; i++ {
		h.ObserveDuration(time.Duration(i) * time.Second)
	}
	snapshot := h.Snapshot()
	if last := snapshot.Cumulative[len(snapshot.Cumulative)-1]; last != snapshot.Count {
		t.Fatalf("+Inf bucket = %d, count = %d", last, snapshot.Count)
	}
}

func TestNewHistogramSortsAndDedupesBounds(t *testing.T) {
	h := NewHistogram([]float64{5, 1, 2, 2, 1})
	got := h.Snapshot().Bounds
	want := []float64{1, 2, 5}
	if len(got) != len(want) {
		t.Fatalf("bounds = %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("bounds = %v, want %v", got, want)
		}
	}
}

// A negative observation means two timestamps came from different clocks.
// Clamping it to zero would publish an impossibly fast operation as a real one.
func TestObserveDiscardsNegativeAndNaN(t *testing.T) {
	h := NewHistogram([]float64{1})
	h.Observe(-1)
	h.ObserveDuration(-time.Second)
	h.Observe(nan())
	if snapshot := h.Snapshot(); snapshot.Count != 0 {
		t.Fatalf("count = %d, want 0", snapshot.Count)
	}
}

func nan() float64 {
	var zero float64
	return zero / zero
}

func TestObserveIsSafeUnderConcurrency(t *testing.T) {
	h := NewHistogram(TaskLatencyBuckets)
	const workers, each = 8, 500
	var wg sync.WaitGroup
	for w := 0; w < workers; w++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for i := 0; i < each; i++ {
				h.Observe(0.5)
			}
		}()
	}
	wg.Wait()
	snapshot := h.Snapshot()
	if snapshot.Count != workers*each {
		t.Errorf("count = %d, want %d", snapshot.Count, workers*each)
	}
	// The sum is the value most at risk from a lost CAS retry.
	if wantSum := 0.5 * float64(workers*each); snapshot.Sum < wantSum-0.01 || snapshot.Sum > wantSum+0.01 {
		t.Errorf("sum = %v, want %v", snapshot.Sum, wantSum)
	}
}

func TestNilHistogramIsInert(t *testing.T) {
	var h *Histogram
	h.Observe(1)
	h.ObserveDuration(time.Second)
	if snapshot := h.Snapshot(); snapshot.Count != 0 {
		t.Fatalf("nil histogram reported %d observations", snapshot.Count)
	}
}

// Cardinality is how a metrics endpoint takes a process down. The bound must
// refuse new series and say that it did, so a dashboard can tell "no traffic"
// from "not measured".
func TestHistogramVecBoundsSeriesAndReportsOverflow(t *testing.T) {
	v := NewHistogramVec(RequestLatencyBuckets)
	for i := 0; i < MaxSeries; i++ {
		if v.With(string(rune('a'+i%26))+string(rune('a'+i/26))) == nil {
			t.Fatalf("series %d was refused before the bound", i)
		}
	}
	if v.Overflowed() {
		t.Fatal("overflow reported at exactly the bound")
	}
	if v.With("one-label-value-too-many") != nil {
		t.Fatal("a series past the bound must be refused")
	}
	if !v.Overflowed() {
		t.Fatal("refusing a series must be reported")
	}
	// The refused label must still be safe to observe into.
	v.With("one-label-value-too-many").Observe(1)
}

func TestHistogramVecReturnsStableSeriesOrder(t *testing.T) {
	v := NewHistogramVec(RequestLatencyBuckets)
	for _, label := range []string{"reports", "media", "billing"} {
		v.With(label).Observe(0.01)
	}
	first := v.Snapshot()
	second := v.Snapshot()
	if len(first) != 3 {
		t.Fatalf("series = %d, want 3", len(first))
	}
	for i := range first {
		if first[i].Label != second[i].Label {
			t.Fatalf("series order is not stable: %v vs %v", first, second)
		}
	}
	if first[0].Label != "billing" || first[2].Label != "reports" {
		t.Errorf("series are not sorted: %v", []string{first[0].Label, first[1].Label, first[2].Label})
	}
}

func TestRenderHistogramProducesValidExposition(t *testing.T) {
	h := NewHistogram([]float64{0.5, 1})
	h.Observe(0.25)
	h.Observe(0.75)
	h.Observe(5)
	var out strings.Builder
	RenderHistogram(&out, "rhinoq_test_seconds", "Help text.", h.Snapshot())
	rendered := out.String()

	for _, want := range []string{
		"# HELP rhinoq_test_seconds Help text.",
		"# TYPE rhinoq_test_seconds histogram",
		`rhinoq_test_seconds_bucket{le="0.5"} 1`,
		`rhinoq_test_seconds_bucket{le="1"} 2`,
		`rhinoq_test_seconds_bucket{le="+Inf"} 3`,
		"rhinoq_test_seconds_count{} 3",
	} {
		if !strings.Contains(rendered, want) {
			t.Errorf("missing %q in:\n%s", want, rendered)
		}
	}
	// One HELP and one TYPE per family, or the scrape is rejected whole.
	if strings.Count(rendered, "# TYPE") != 1 {
		t.Errorf("expected exactly one TYPE line:\n%s", rendered)
	}
}

func TestRenderHistogramVecEmitsOneFamilyHeaderForAllSeries(t *testing.T) {
	v := NewHistogramVec([]float64{1})
	v.With("reports").Observe(0.5)
	v.With("media").Observe(2)
	var out strings.Builder
	RenderHistogramVec(&out, "rhinoq_queue_seconds", "Help.", "queue", v.Snapshot())
	rendered := out.String()

	if strings.Count(rendered, "# TYPE") != 1 || strings.Count(rendered, "# HELP") != 1 {
		t.Errorf("a metric family must carry one HELP and one TYPE:\n%s", rendered)
	}
	for _, want := range []string{
		`rhinoq_queue_seconds_bucket{queue="media",le="1"} 0`,
		`rhinoq_queue_seconds_bucket{queue="media",le="+Inf"} 1`,
		`rhinoq_queue_seconds_bucket{queue="reports",le="1"} 1`,
		`rhinoq_queue_seconds_count{queue="reports"} 1`,
	} {
		if !strings.Contains(rendered, want) {
			t.Errorf("missing %q in:\n%s", want, rendered)
		}
	}
}

// A newline or quote in a label value would let a queue name inject a whole
// fake metric line into the scrape.
func TestRenderEscapesLabelValues(t *testing.T) {
	v := NewHistogramVec([]float64{1})
	v.With("evil\"\nrhinoq_fake_metric 1").Observe(0.5)
	var out strings.Builder
	RenderHistogramVec(&out, "rhinoq_queue_seconds", "Help.", "queue", v.Snapshot())
	rendered := out.String()

	for _, line := range strings.Split(rendered, "\n") {
		trimmed := strings.TrimSpace(line)
		if trimmed == "rhinoq_fake_metric 1" {
			t.Fatalf("a label value injected a metric line:\n%s", rendered)
		}
	}
	if !strings.Contains(rendered, `\n`) || !strings.Contains(rendered, `\"`) {
		t.Errorf("label value was not escaped:\n%s", rendered)
	}
}
