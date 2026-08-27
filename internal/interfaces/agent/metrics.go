package agent

import (
	"fmt"
	"net/http"
	"sort"
	"strings"

	"github.com/madebyduy/RhinoQ/internal/infrastructure/telemetry"
)

// handleMetrics writes the Prometheus text exposition format directly. RhinoQ
// exports metrics rather than building its own monitoring, and doing it in a
// few lines of stdlib keeps the engine free of a client library dependency.
func (s *Server) handleMetrics(w http.ResponseWriter, r *http.Request) {
	counts, err := s.client.JobCounts(r.Context(), "")
	if err != nil {
		s.fail(w, err)
		return
	}

	var out strings.Builder
	metric(&out, "rhinoq_build_info", "gauge",
		"Build information for the running Agent.",
		fmt.Sprintf(`rhinoq_build_info{version=%q,protocol=%q} 1`, s.version, ProtocolVersion))

	states := make([]string, 0, len(counts))
	for state := range counts {
		states = append(states, state)
	}
	sort.Strings(states)
	lines := make([]string, 0, len(states))
	for _, state := range states {
		lines = append(lines, fmt.Sprintf("rhinoq_jobs{state=%q} %d", state, counts[state]))
	}
	if len(lines) == 0 {
		lines = append(lines, `rhinoq_jobs{state="pending"} 0`)
	}
	metric(&out, "rhinoq_jobs", "gauge", "Jobs by execution state.", lines...)

	if schedules, configured, statsErr := s.client.RecurringTaskStats(r.Context()); statsErr != nil {
		s.fail(w, statsErr)
		return
	} else if configured {
		metric(&out, "rhinoq_recurring_schedules", "gauge", "Recurring Task schedules by operational state.",
			fmt.Sprintf(`rhinoq_recurring_schedules{state="enabled"} %d`, schedules.Enabled),
			fmt.Sprintf(`rhinoq_recurring_schedules{state="paused"} %d`, schedules.Paused),
			fmt.Sprintf(`rhinoq_recurring_schedules{state="due"} %d`, schedules.Due),
			fmt.Sprintf(`rhinoq_recurring_schedules{state="leased"} %d`, schedules.Leased),
			fmt.Sprintf(`rhinoq_recurring_schedules{state="failed"} %d`, schedules.Failed))
		metric(&out, "rhinoq_recurring_oldest_due_lag_seconds", "gauge", "Seconds the oldest due recurring schedule has waited past its scheduled time.",
			fmt.Sprintf("rhinoq_recurring_oldest_due_lag_seconds %.3f", schedules.OldestDueLag.Seconds()))
	}

	metric(&out, "rhinoq_agent_jobs_accepted_total", "counter",
		"Jobs enqueued or completed through this Agent since it started.",
		fmt.Sprintf("rhinoq_agent_jobs_accepted_total %d", s.handled.Load()))
	metric(&out, "rhinoq_agent_jobs_failed_total", "counter",
		"Failures reported through this Agent since it started.",
		fmt.Sprintf("rhinoq_agent_jobs_failed_total %d", s.failed.Load()))

	// Distributions come after the counters and gauges. They answer the questions
	// a count cannot: a mean claim wait hides the tail an operator is paged
	// about, and a percentile is the only form in which a latency budget can be
	// stated or an end-to-end benchmark reported.
	telemetry.RenderHistogramVec(&out, "rhinoq_claim_wait_seconds",
		"Seconds a job was eligible to run before a worker claimed it, by queue. "+
			"Intended delay from a scheduled run time or a retry backoff is excluded.",
		"queue", s.client.Metrics().ClaimWait.Snapshot())

	telemetry.RenderHistogramVec(&out, "rhinoq_execution_duration_seconds",
		"Seconds a handler ran, by queue. Measured around the handler call only, "+
			"so RhinoQ's own claim and terminal-write overhead is excluded. "+
			"Successes and failures share the series.",
		"queue", s.client.Metrics().ExecutionDuration.Snapshot())

	telemetry.RenderHistogramVec(&out, "rhinoq_agent_request_duration_seconds",
		"Seconds the Agent took to serve a request, by matched route. "+
			"Rejected requests are included.",
		"route", s.requestLatency.Snapshot())

	// A truncated metric must say so. Without this line a dashboard cannot tell
	// a queue with no traffic from a queue whose series was refused at the
	// cardinality bound, and would report the second as healthy.
	metric(&out, "rhinoq_metric_series_truncated", "gauge",
		"Whether a metric family stopped tracking new label values at the series bound.",
		fmt.Sprintf("rhinoq_metric_series_truncated{family=\"claim_wait\"} %d",
			boolGauge(s.client.Metrics().ClaimWait.Overflowed())),
		fmt.Sprintf("rhinoq_metric_series_truncated{family=\"request_duration\"} %d",
			boolGauge(s.requestLatency.Overflowed())),
		fmt.Sprintf("rhinoq_metric_series_truncated{family=\"execution_duration\"} %d",
			boolGauge(s.client.Metrics().ExecutionDuration.Overflowed())))

	ready := 1
	if s.draining.Load() {
		ready = 0
	}
	metric(&out, "rhinoq_agent_ready", "gauge",
		"Whether this Agent is accepting traffic. Zero means draining.",
		fmt.Sprintf("rhinoq_agent_ready %d", ready))

	w.Header().Set("Content-Type", "text/plain; version=0.0.4; charset=utf-8")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write([]byte(out.String()))
}

func boolGauge(value bool) int {
	if value {
		return 1
	}
	return 0
}

func metric(out *strings.Builder, name, kind, help string, samples ...string) {
	fmt.Fprintf(out, "# HELP %s %s\n# TYPE %s %s\n", name, help, name, kind)
	for _, sample := range samples {
		out.WriteString(sample)
		out.WriteString("\n")
	}
}
