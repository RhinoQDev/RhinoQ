package agent

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/madebyduy/RhinoQ/internal/domain/correlation"
	"github.com/madebyduy/RhinoQ/pkg/rhinoq"
)

const (
	traceTestToken = "trace-test-token-at-least-thirty-two-bytes"
	traceTestID    = "4bf92f3577b34da6a3ce929d0e0e4736"
	traceTestSpan  = "00f067aa0ba902b7"
	traceTestValue = "00-" + traceTestID + "-" + traceTestSpan + "-01"
)

// traceTestServer returns a server plus one Task that executions can be created
// against, because an Execution has no meaning without its Task.
func traceTestServer(t *testing.T) *Server {
	t.Helper()
	server, err := New(Config{Client: rhinoq.NewInMemory(), Token: traceTestToken})
	if err != nil {
		t.Fatal(err)
	}
	create := httptest.NewRequest(http.MethodPost, "/v1/tasks",
		bytes.NewBufferString(`{"id":"task-trace-1","type":"export","definitionVersion":1}`))
	create.Header.Set("Authorization", "Bearer "+traceTestToken)
	response := httptest.NewRecorder()
	server.ServeHTTP(response, create)
	if response.Code != http.StatusCreated {
		t.Fatalf("seed task: %d %s", response.Code, response.Body.String())
	}
	return server
}

// createExecution posts one attempt and returns the recorder, so a test can
// assert on both the body and the echoed headers.
func createExecution(t *testing.T, server *Server, id string, headers map[string]string, body string) *httptest.ResponseRecorder {
	t.Helper()
	if body == "" {
		body = `{"id":"` + id + `","runtime":"native"}`
	}
	request := httptest.NewRequest(http.MethodPost, "/v1/tasks/task-trace-1/executions",
		bytes.NewBufferString(body))
	request.Header.Set("Authorization", "Bearer "+traceTestToken)
	for name, value := range headers {
		request.Header.Set(name, value)
	}
	response := httptest.NewRecorder()
	server.ServeHTTP(response, request)
	return response
}

// executionTraceID reads the trace id back out of the snapshot for the given
// attempt id. Reading it from the response the caller actually receives is the
// point: a trace stored but not published is not usable by an operator.
func executionTraceID(t *testing.T, body string, executionID string) (string, bool) {
	t.Helper()
	var snapshot struct {
		Executions []struct {
			ID      string `json:"id"`
			TraceID string `json:"traceId"`
		} `json:"executions"`
	}
	if err := json.Unmarshal([]byte(body), &snapshot); err != nil {
		t.Fatalf("decode snapshot: %v (%s)", err, body)
	}
	for _, item := range snapshot.Executions {
		if item.ID == executionID {
			return item.TraceID, true
		}
	}
	return "", false
}

func TestExecutionRecordsIncomingTraceParent(t *testing.T) {
	server := traceTestServer(t)
	response := createExecution(t, server, "exec-trace-1",
		map[string]string{correlation.TraceParentHeader: traceTestValue}, "")
	if response.Code != http.StatusCreated {
		t.Fatalf("create execution: %d %s", response.Code, response.Body.String())
	}
	traceID, found := executionTraceID(t, response.Body.String(), "exec-trace-1")
	if !found {
		t.Fatalf("attempt missing from snapshot: %s", response.Body.String())
	}
	if traceID != traceTestID {
		t.Errorf("published trace id = %q, want %q", traceID, traceTestID)
	}
	// The echo is what makes propagation verifiable from outside the process.
	if got := response.Header().Get(correlation.TraceParentHeader); got != traceTestValue {
		t.Errorf("echoed traceparent = %q, want %q", got, traceTestValue)
	}
}

// A corrupted header must cost the caller its correlation and nothing else. The
// alternative — refusing the request — lets any misconfigured proxy between the
// caller and RhinoQ stop real work.
func TestMalformedTraceParentIsDroppedNotRejected(t *testing.T) {
	for name, header := range map[string]string{
		"garbage":           "not-a-trace-context",
		"all-zero trace id": "00-" + strings.Repeat("0", 32) + "-" + traceTestSpan + "-01",
		"uppercase":         "00-" + strings.ToUpper(traceTestID) + "-" + traceTestSpan + "-01",
		"truncated":         "00-" + traceTestID,
		"version ff":        "ff-" + traceTestID + "-" + traceTestSpan + "-01",
	} {
		t.Run(name, func(t *testing.T) {
			server := traceTestServer(t)
			response := createExecution(t, server, "exec-bad-trace",
				map[string]string{correlation.TraceParentHeader: header}, "")
			if response.Code != http.StatusCreated {
				t.Fatalf("a malformed trace header must not fail the request: %d %s",
					response.Code, response.Body.String())
			}
			traceID, found := executionTraceID(t, response.Body.String(), "exec-bad-trace")
			if !found {
				t.Fatalf("attempt missing from snapshot: %s", response.Body.String())
			}
			if traceID != "" {
				t.Errorf("malformed header was stored as %q, want empty", traceID)
			}
			// Echoing nothing is how the response says "received and discarded"
			// rather than "recorded".
			if got := response.Header().Get(correlation.TraceParentHeader); got != "" {
				t.Errorf("discarded header was echoed as %q", got)
			}
		})
	}
}

func TestExecutionWithoutTraceParentStoresNoTrace(t *testing.T) {
	server := traceTestServer(t)
	response := createExecution(t, server, "exec-no-trace", nil, "")
	if response.Code != http.StatusCreated {
		t.Fatalf("create execution: %d %s", response.Code, response.Body.String())
	}
	traceID, found := executionTraceID(t, response.Body.String(), "exec-no-trace")
	if !found {
		t.Fatalf("attempt missing from snapshot: %s", response.Body.String())
	}
	if traceID != "" {
		t.Errorf("absent trace was materialised as %q", traceID)
	}
	if got := response.Header().Get(correlation.TraceParentHeader); got != "" {
		t.Errorf("no trace was presented but %q was echoed", got)
	}
}

// The body is the explicit statement and wins over the transport header. A
// batch producer creating many attempts from one HTTP call needs each attempt
// attributed to the upstream work that produced it, not to the submitting call.
func TestRequestBodyTraceParentOverridesHeader(t *testing.T) {
	server := traceTestServer(t)
	bodyTraceID := "0af7651916cd43dd8448eb211c80319c"
	bodyTrace := "00-" + bodyTraceID + "-b7ad6b7169203331-01"
	response := createExecution(t, server, "exec-body-trace",
		map[string]string{correlation.TraceParentHeader: traceTestValue},
		`{"id":"exec-body-trace","runtime":"native","traceparent":"`+bodyTrace+`"}`)
	if response.Code != http.StatusCreated {
		t.Fatalf("create execution: %d %s", response.Code, response.Body.String())
	}
	traceID, found := executionTraceID(t, response.Body.String(), "exec-body-trace")
	if !found {
		t.Fatalf("attempt missing from snapshot: %s", response.Body.String())
	}
	if traceID != bodyTraceID {
		t.Errorf("stored trace id = %q, want the body value %q", traceID, bodyTraceID)
	}
}

// Each attempt carries its own trace. Attributing a later attempt to the caller
// that triggered the first would point an investigation at a request that is not
// the one that failed.
func TestEachAttemptCarriesItsOwnTrace(t *testing.T) {
	server := traceTestServer(t)
	first := createExecution(t, server, "exec-attempt-1",
		map[string]string{correlation.TraceParentHeader: traceTestValue}, "")
	if first.Code != http.StatusCreated {
		t.Fatalf("first attempt: %d %s", first.Code, first.Body.String())
	}
	secondTraceID := "0af7651916cd43dd8448eb211c80319c"
	second := createExecution(t, server, "exec-attempt-2",
		map[string]string{correlation.TraceParentHeader: "00-" + secondTraceID + "-b7ad6b7169203331-01"}, "")
	if second.Code != http.StatusCreated {
		t.Fatalf("second attempt: %d %s", second.Code, second.Body.String())
	}

	body := second.Body.String()
	firstTrace, ok := executionTraceID(t, body, "exec-attempt-1")
	if !ok {
		t.Fatalf("first attempt missing from snapshot: %s", body)
	}
	secondTrace, ok := executionTraceID(t, body, "exec-attempt-2")
	if !ok {
		t.Fatalf("second attempt missing from snapshot: %s", body)
	}
	if firstTrace != traceTestID {
		t.Errorf("first attempt trace = %q, want %q", firstTrace, traceTestID)
	}
	if secondTrace != secondTraceID {
		t.Errorf("second attempt trace = %q, want %q", secondTrace, secondTraceID)
	}
	if firstTrace == secondTrace {
		t.Error("two attempts from different callers share one trace id")
	}
}
