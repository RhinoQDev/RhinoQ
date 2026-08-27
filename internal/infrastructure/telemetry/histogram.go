// Package telemetry holds the measurement primitives RhinoQ exports.
//
// It exists because counters and gauges cannot answer the questions RhinoQ is
// judged on. "How many jobs are pending" is a gauge; "is a Task picked up
// promptly" is a distribution, and a mean hides exactly the tail an operator is
// paged about. Publishing p95 and p99 also happens to be the precondition for
// the end-to-end latency evidence the roadmap owes an adopter: a benchmark
// without percentiles is an anecdote.
//
// The implementation is deliberately small rather than a client library. RhinoQ
// runs on one direct dependency, and a histogram with fixed buckets is roughly
// a hundred lines: importing an instrumentation SDK to get them would cost more
// than it returns, and would pull a background exporter into a process whose
// whole claim is that it is a queue engine and nothing else.
package telemetry

import (
	"math"
	"sort"
	"sync"
	"sync/atomic"
	"time"
)

// TaskLatencyBuckets spans the range durable task work actually occupies:
// milliseconds for a healthy claim, minutes for a media conversion or a slow
// provider. A range that stops at ten seconds would put every interesting
// failure in the overflow bucket, where a percentile cannot be estimated at all.
var TaskLatencyBuckets = []float64{
	0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120, 300, 600,
}

// RequestLatencyBuckets is tighter because an HTTP call to the Agent that takes
// a second is already the problem being investigated.
var RequestLatencyBuckets = []float64{
	0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10,
}

// Histogram is a cumulative histogram with fixed bucket boundaries.
//
// Observations are lock-free so a claim or request path never blocks on
// measurement. The counters are exact; only the bucket resolution is
// approximate, which is the trade every Prometheus histogram makes.
type Histogram struct {
	bounds []float64
	counts []atomic.Uint64
	// sumBits holds a float64 through math.Float64bits. A CAS loop is used
	// rather than a mutex because the alternative is serialising every
	// observation on the hot path to keep a number that is only ever read by a
	// scrape.
	sumBits atomic.Uint64
	total   atomic.Uint64
}

// NewHistogram copies and sorts the boundaries, so a caller passing an unsorted
// slice gets a correct histogram instead of silently wrong buckets. Duplicate
// and non-finite boundaries are dropped for the same reason: a le label that
// repeats makes the exposition invalid, and Prometheus rejects the whole scrape
// rather than the one metric.
func NewHistogram(bounds []float64) *Histogram {
	cleaned := make([]float64, 0, len(bounds))
	for _, bound := range bounds {
		if math.IsNaN(bound) || math.IsInf(bound, 0) {
			continue
		}
		cleaned = append(cleaned, bound)
	}
	sort.Float64s(cleaned)
	deduped := cleaned[:0]
	for i, bound := range cleaned {
		if i == 0 || bound != cleaned[i-1] {
			deduped = append(deduped, bound)
		}
	}
	return &Histogram{
		bounds: deduped,
		// One extra slot is the +Inf bucket, which the exposition format
		// requires and which must equal the observation count.
		counts: make([]atomic.Uint64, len(deduped)+1),
	}
}

// Observe records one value in seconds.
//
// A negative duration is discarded rather than clamped to zero. It means a
// clock moved backwards or two timestamps came from different sources, and
// folding that into the first bucket would report an impossibly fast operation
// as a real one.
func (h *Histogram) Observe(seconds float64) {
	if h == nil || math.IsNaN(seconds) || seconds < 0 {
		return
	}
	index := sort.SearchFloat64s(h.bounds, seconds)
	// SearchFloat64s returns the first index whose bound is >= seconds, which is
	// the bucket that owns the observation because Prometheus buckets are
	// upper-inclusive. A value past every bound lands on len(bounds), the +Inf
	// slot.
	if index < len(h.bounds) && h.bounds[index] < seconds {
		index++
	}
	h.counts[index].Add(1)
	h.total.Add(1)
	for {
		current := h.sumBits.Load()
		next := math.Float64bits(math.Float64frombits(current) + seconds)
		if h.sumBits.CompareAndSwap(current, next) {
			return
		}
	}
}

// ObserveDuration is the form every call site actually wants.
func (h *Histogram) ObserveDuration(d time.Duration) { h.Observe(d.Seconds()) }

// HistogramSnapshot is a consistent-enough read for a scrape. Bucket counts are
// cumulative, matching the exposition format so the renderer does no arithmetic.
type HistogramSnapshot struct {
	Bounds []float64
	// Cumulative has one entry per bound plus a final +Inf entry.
	Cumulative []uint64
	Sum        float64
	Count      uint64
}

// Snapshot reads the counters. It is not a locked instant across all of them:
// an observation landing mid-read can make Count trail the last bucket by one.
// That is accepted deliberately — the alternative is a lock on Observe, and a
// scrape that is off by one observation changes no percentile anyone acts on.
func (h *Histogram) Snapshot() HistogramSnapshot {
	if h == nil {
		return HistogramSnapshot{}
	}
	cumulative := make([]uint64, len(h.counts))
	var running uint64
	for i := range h.counts {
		running += h.counts[i].Load()
		cumulative[i] = running
	}
	return HistogramSnapshot{
		Bounds:     h.bounds,
		Cumulative: cumulative,
		Sum:        math.Float64frombits(h.sumBits.Load()),
		Count:      h.total.Load(),
	}
}

// MaxSeries bounds how many label values one HistogramVec will track.
//
// Cardinality is the way metrics take a process down, and the labels here are
// derived from queue names and route patterns that RhinoQ does not fully
// control. A bound turns an unbounded leak into a visible, reported truncation:
// see Overflowed.
const MaxSeries = 64

// HistogramVec is a histogram partitioned by one label value.
//
// One label, not a set: every question these metrics answer is "per queue" or
// "per route", and accepting arbitrary label combinations is how a metrics
// endpoint becomes the most expensive part of a request.
type HistogramVec struct {
	bounds []float64
	mu     sync.RWMutex
	series map[string]*Histogram
	// overflowed records that at least one label value was refused, so a
	// dashboard reading these numbers can tell "no traffic" from "not measured".
	overflowed atomic.Bool
}

func NewHistogramVec(bounds []float64) *HistogramVec {
	return &HistogramVec{bounds: bounds, series: make(map[string]*Histogram)}
}

// With returns the histogram for one label value, or nil once the series bound
// is reached. Observe tolerates a nil receiver, so a caller does not have to
// check: dropping the observation is the intended behaviour at the bound.
func (v *HistogramVec) With(label string) *Histogram {
	v.mu.RLock()
	existing, found := v.series[label]
	v.mu.RUnlock()
	if found {
		return existing
	}
	v.mu.Lock()
	defer v.mu.Unlock()
	if existing, found := v.series[label]; found {
		return existing
	}
	if len(v.series) >= MaxSeries {
		v.overflowed.Store(true)
		return nil
	}
	created := NewHistogram(v.bounds)
	v.series[label] = created
	return created
}

// Overflowed reports whether any label value was refused for exceeding
// MaxSeries.
func (v *HistogramVec) Overflowed() bool { return v.overflowed.Load() }

// Snapshot returns every series in a stable label order, so a scrape does not
// reorder lines between polls.
func (v *HistogramVec) Snapshot() []LabelledSnapshot {
	v.mu.RLock()
	labels := make([]string, 0, len(v.series))
	for label := range v.series {
		labels = append(labels, label)
	}
	histograms := make([]*Histogram, 0, len(labels))
	sort.Strings(labels)
	for _, label := range labels {
		histograms = append(histograms, v.series[label])
	}
	v.mu.RUnlock()

	out := make([]LabelledSnapshot, 0, len(labels))
	for i, label := range labels {
		out = append(out, LabelledSnapshot{Label: label, Snapshot: histograms[i].Snapshot()})
	}
	return out
}

type LabelledSnapshot struct {
	Label    string
	Snapshot HistogramSnapshot
}
