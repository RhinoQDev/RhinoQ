package agent

import (
	"fmt"
	"net/http"
	"sort"
	"strings"
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

	metric(&out, "rhinoq_agent_jobs_accepted_total", "counter",
		"Jobs enqueued or completed through this Agent since it started.",
		fmt.Sprintf("rhinoq_agent_jobs_accepted_total %d", s.handled.Load()))
	metric(&out, "rhinoq_agent_jobs_failed_total", "counter",
		"Failures reported through this Agent since it started.",
		fmt.Sprintf("rhinoq_agent_jobs_failed_total %d", s.failed.Load()))

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

func metric(out *strings.Builder, name, kind, help string, samples ...string) {
	fmt.Fprintf(out, "# HELP %s %s\n# TYPE %s %s\n", name, help, name, kind)
	for _, sample := range samples {
		out.WriteString(sample)
		out.WriteString("\n")
	}
}
