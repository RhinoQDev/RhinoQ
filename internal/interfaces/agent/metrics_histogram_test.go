package agent

import (
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"

	"github.com/madebyduy/RhinoQ/pkg/rhinoq"
)

const metricsTestToken = "metrics-test-token-at-least-32-bytes"

func scrape(t *testing.T, server *Server) string {
	t.Helper()
	request := httptest.NewRequest(http.MethodGet, "/metrics", nil)
	request.Header.Set("Authorization", "Bearer "+metricsTestToken)
	response := httptest.NewRecorder()
	server.ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("scrape: %d %s", response.Code, response.Body.String())
	}
	return response.Body.String()
}

func metricsTestServer(t *testing.T) *Server {
	t.Helper()
	server, err := New(Config{Client: rhinoq.NewInMemory(), Token: metricsTestToken})
	if err != nil {
		t.Fatal(err)
	}
	return server
}

func TestMetricsExportsLatencyHistograms(t *testing.T) {
	server := metricsTestServer(t)
	// One scrape is itself a served request, so the second scrape must already
	// see a request-duration series for the /metrics route.
	scrape(t, server)
	body := scrape(t, server)

	for _, want := range []string{
		"# TYPE rhinoq_claim_wait_seconds histogram",
		"# TYPE rhinoq_agent_request_duration_seconds histogram",
		`rhinoq_agent_request_duration_seconds_bucket{route="GET /metrics",le="+Inf"}`,
		`rhinoq_agent_request_duration_seconds_count{route="GET /metrics"}`,
		"rhinoq_metric_series_truncated",
	} {
		if !strings.Contains(body, want) {
			t.Errorf("missing %q in scrape:\n%s", want, body)
		}
	}
}

// The route label must come from the matched pattern. Labelling by path would
// create one series per Task id and turn the metrics endpoint into the most
// expensive thing in the process.
func TestRequestDurationLabelsByRoutePatternNotPath(t *testing.T) {
	server := metricsTestServer(t)
	for _, id := range []string{"task-a", "task-b", "task-c"} {
		request := httptest.NewRequest(http.MethodGet, "/v1/tasks/"+id, nil)
		request.Header.Set("Authorization", "Bearer "+metricsTestToken)
		server.ServeHTTP(httptest.NewRecorder(), request)
	}
	body := scrape(t, server)

	for _, id := range []string{"task-a", "task-b", "task-c"} {
		if strings.Contains(body, id) {
			t.Errorf("a request path id leaked into a metric label: %q\n%s", id, body)
		}
	}
	if !strings.Contains(body, `route="GET /v1/tasks/{id}"`) {
		t.Errorf("expected one series for the route pattern:\n%s", body)
	}
	// Three requests, one series, three observations.
	if !strings.Contains(body, `rhinoq_agent_request_duration_seconds_count{route="GET /v1/tasks/{id}"} 3`) {
		t.Errorf("the three requests did not collapse onto one series:\n%s", body)
	}
}

// A rejected request is traffic and must be measured. An endpoint being flooded
// with 401s should not look idle in a latency panel.
func TestRejectedRequestsAreMeasured(t *testing.T) {
	server := metricsTestServer(t)
	unauthorized := httptest.NewRequest(http.MethodGet, "/v1/jobs", nil)
	response := httptest.NewRecorder()
	server.ServeHTTP(response, unauthorized)
	if response.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %d", response.Code)
	}
	body := scrape(t, server)
	if !strings.Contains(body, `rhinoq_agent_request_duration_seconds_count{route="GET /v1/jobs"} 1`) {
		t.Errorf("a rejected request was not measured:\n%s", body)
	}
}

// Every histogram family in the scrape must be well formed, because Prometheus
// rejects a whole scrape over one bad line rather than dropping that metric.
func TestScrapeHistogramsAreWellFormed(t *testing.T) {
	server := metricsTestServer(t)
	scrape(t, server)
	body := scrape(t, server)

	types := map[string]int{}
	helps := map[string]int{}
	// Track the last +Inf bucket and _count per series so they can be compared.
	infBucket := map[string]uint64{}
	counts := map[string]uint64{}

	for _, line := range strings.Split(body, "\n") {
		switch {
		case strings.HasPrefix(line, "# TYPE "):
			fields := strings.Fields(line)
			if len(fields) == 4 && fields[3] == "histogram" {
				types[fields[2]]++
			}
		case strings.HasPrefix(line, "# HELP "):
			fields := strings.Fields(line)
			if len(fields) >= 3 {
				helps[fields[2]]++
			}
		case strings.Contains(line, `_bucket{`) && strings.Contains(line, `le="+Inf"`):
			name, series, value := parseSample(t, line)
			infBucket[name+"|"+series] = value
		case strings.Contains(line, "_count{"):
			name, series, value := parseSample(t, line)
			counts[name+"|"+series] = value
		}
	}

	if len(types) == 0 {
		t.Fatalf("no histogram families in scrape:\n%s", body)
	}
	for name, seen := range types {
		if seen != 1 {
			t.Errorf("family %s declared TYPE %d times; exactly one is valid", name, seen)
		}
		if helps[name] != 1 {
			t.Errorf("family %s declared HELP %d times; exactly one is valid", name, helps[name])
		}
	}
	// The +Inf bucket equalling _count is the invariant a scraper treats as
	// corrupt data when broken.
	for key, inf := range infBucket {
		if count, found := counts[key]; found && inf != count {
			t.Errorf("%s: +Inf bucket = %d but _count = %d", key, inf, count)
		}
	}
}

// parseSample splits "name_suffix{labels} value" into the metric family name,
// the label set with any le label removed, and the value.
func parseSample(t *testing.T, line string) (string, string, uint64) {
	t.Helper()
	open := strings.Index(line, "{")
	close := strings.LastIndex(line, "}")
	if open < 0 || close < open {
		t.Fatalf("unparseable sample: %q", line)
	}
	name := line[:open]
	name = strings.TrimSuffix(strings.TrimSuffix(name, "_bucket"), "_count")
	labels := line[open+1 : close]
	kept := make([]string, 0, 2)
	for _, pair := range strings.Split(labels, ",") {
		if pair == "" || strings.HasPrefix(pair, "le=") {
			continue
		}
		kept = append(kept, pair)
	}
	raw := strings.TrimSpace(line[close+1:])
	value, err := strconv.ParseUint(raw, 10, 64)
	if err != nil {
		t.Fatalf("unparseable value in %q: %v", line, err)
	}
	return name, strings.Join(kept, ","), value
}
