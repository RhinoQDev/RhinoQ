package telemetry

import (
	"strings"
	"time"
)

// EngineMetrics is the set of distributions the engine can measure honestly.
//
// "Honestly" is the constraint that decided the contents. A latency is only
// worth publishing when both of its endpoints come from the same clock: a wait
// measured between a database timestamp and a worker's wall clock reports the
// clock skew between two machines as queue latency, and an operator cannot tell
// the two apart from a dashboard. Every metric here is therefore observed at a
// point that holds both timestamps.
type EngineMetrics struct {
	// ClaimWait is how long a job was eligible to run before a worker took it,
	// partitioned by queue. It is the queue-health question: a rising p95 here
	// means not enough worker capacity, while a rising execution duration means
	// the work itself got slower, and conflating them sends an operator to the
	// wrong fix.
	ClaimWait *HistogramVec
	// ExecutionDuration is how long a handler ran, partitioned by queue. Read
	// together with ClaimWait it separates "not enough workers" from "the work
	// got slower", which are different incidents with different fixes.
	ExecutionDuration *HistogramVec
}

func NewEngineMetrics() *EngineMetrics {
	return &EngineMetrics{
		ClaimWait:         NewHistogramVec(TaskLatencyBuckets),
		ExecutionDuration: NewHistogramVec(TaskLatencyBuckets),
	}
}

// ObserveClaimWait records one claim, given the instants the store itself
// produced.
//
// readyAt is when the job became eligible, which is not when it was created: a
// delayed job or a retry with backoff is intentionally not runnable yet, and
// counting that intended delay as queue wait would make a correctly-configured
// backoff look like a capacity problem.
//
// Both instants are expected to come from the store. A zero readyAt or a claim
// that appears to precede it is dropped rather than recorded as zero: the first
// is missing data and the second is clock disagreement, and neither is a fast
// claim.
func (m *EngineMetrics) ObserveClaimWait(queue string, readyAt, claimedAt time.Time) {
	if m == nil || m.ClaimWait == nil {
		return
	}
	if readyAt.IsZero() || claimedAt.IsZero() || claimedAt.Before(readyAt) {
		return
	}
	m.ClaimWait.With(QueueLabel(queue)).ObserveDuration(claimedAt.Sub(readyAt))
}

// ReadyAt is when a job became eligible to run: the later of its creation and
// its not-before instant. It is exported because the same rule has to hold
// wherever a wait is measured, and two call sites computing it separately is how
// they drift apart.
func ReadyAt(createdAt, notBefore time.Time) time.Time {
	if notBefore.After(createdAt) {
		return notBefore
	}
	return createdAt
}

// unlabelled is used rather than an empty label so a series with no queue name
// is still identifiable in a dashboard, instead of rendering as queue="".
const unlabelled = "unlabelled"

// QueueLabel bounds one queue name to something safe to use as a label value.
//
// Queue names come from the adopter's application, so they are untrusted for
// both length and content: an unbounded name inflates every scrape it appears
// in, and the escaping in render.go handles the characters but not the size.
func QueueLabel(name string) string {
	trimmed := strings.TrimSpace(name)
	if trimmed == "" {
		return unlabelled
	}
	const maxLabelBytes = 96
	if len(trimmed) > maxLabelBytes {
		return trimmed[:maxLabelBytes]
	}
	return trimmed
}

// ObserveExecution records how long a handler ran for one job.
//
// Both instants come from the worker's own clock inside one function call, which
// is why this is measured in the runtime rather than derived from stored
// timestamps: a duration computed from a database write and a worker clock
// reports the skew between two machines as execution time.
//
// Successes and failures share the series. Splitting them would need a second
// label, and the question this metric answers - "did the work itself get
// slower" - is the same either way; a failure rate is already a counter.
func (m *EngineMetrics) ObserveExecution(queue string, elapsed time.Duration) {
	if m == nil || m.ExecutionDuration == nil || elapsed < 0 {
		return
	}
	m.ExecutionDuration.With(QueueLabel(queue)).ObserveDuration(elapsed)
}
