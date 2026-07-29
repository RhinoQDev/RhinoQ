package integration

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/madebyduy/RhinoQ/internal/interfaces/agent"
	"github.com/madebyduy/RhinoQ/pkg/rhinoq"
)

const agentToken = "test-token-at-least-thirty-two-bytes"

func TestAgentTaskPollingContractRejectsStaleWrites(t *testing.T) {
	server := newAgentServer(t)
	var created rhinoq.TaskSnapshot
	call(t, server, http.MethodPost, "/v1/tasks", map[string]any{
		"id": "task-1", "type": "report.export",
		"ownerId": "private-owner", "definitionVersion": 1,
	}, http.StatusCreated, &created)
	if created.SchemaVersion != 1 || created.EntityVersion != 1 ||
		created.State != rhinoq.TaskPending {
		t.Fatalf("unexpected initial snapshot: %+v", created)
	}

	var withExecution rhinoq.TaskSnapshot
	call(t, server, http.MethodPost, "/v1/tasks/task-1/executions", map[string]any{
		"id": "exec-1", "runtime": "bullmq",
	}, http.StatusCreated, &withExecution)
	var bound rhinoq.TaskSnapshot
	call(t, server, http.MethodPost, "/v1/task-executions/exec-1/bind", map[string]any{
		"runtime": "bullmq", "externalId": "bull-job-1",
	}, http.StatusOK, &bound)
	if bound.EntityVersion != created.EntityVersion+2 ||
		len(bound.Executions) != 1 || bound.Executions[0].State != "dispatched" {
		t.Fatalf("execution binding must advance the aggregate snapshot: %+v", bound)
	}
	var bindConflict struct {
		Error agent.ErrorBody `json:"error"`
	}
	call(t, server, http.MethodPost, "/v1/task-executions/exec-1/bind", map[string]any{
		"runtime": "bullmq", "externalId": "bull-job-1",
	}, http.StatusConflict, &bindConflict)
	if bindConflict.Error.Code != "RHINOQ_EXECUTION_ALREADY_BOUND" {
		t.Fatalf("repeated binding needs a typed conflict: %+v", bindConflict.Error)
	}

	var queued rhinoq.TaskSnapshot
	call(t, server, http.MethodPost, "/v1/tasks/task-1/state", map[string]any{
		"expectedVersion": bound.EntityVersion, "state": rhinoq.TaskQueued,
	}, http.StatusOK, &queued)
	var running rhinoq.TaskSnapshot
	call(t, server, http.MethodPost, "/v1/tasks/task-1/state", map[string]any{
		"expectedVersion": queued.EntityVersion, "state": rhinoq.TaskRunning,
	}, http.StatusOK, &running)

	total := int64(10)
	var progressed rhinoq.TaskSnapshot
	call(t, server, http.MethodPost, "/v1/tasks/task-1/progress", map[string]any{
		"expectedVersion": running.EntityVersion,
		"progress": map[string]any{
			"completed": 4, "total": total, "message": "exporting",
		},
	}, http.StatusOK, &progressed)

	var polled rhinoq.TaskSnapshot
	call(t, server, http.MethodGet, "/v1/tasks/task-1", nil, http.StatusOK, &polled)
	if polled.EntityVersion != progressed.EntityVersion ||
		polled.Progress.Completed != 4 || polled.Progress.Total == nil ||
		*polled.Progress.Total != total {
		t.Fatalf("polling did not return the latest snapshot: %+v", polled)
	}

	var conflict struct {
		Error agent.ErrorBody `json:"error"`
	}
	call(t, server, http.MethodPost, "/v1/tasks/task-1/state", map[string]any{
		"expectedVersion": running.EntityVersion, "state": rhinoq.TaskSucceeded,
	}, http.StatusConflict, &conflict)
	if conflict.Error.Code != "RHINOQ_VERSION_CONFLICT" {
		t.Fatalf("stale task writes need a typed conflict: %+v", conflict.Error)
	}

	var result rhinoq.TaskResult
	call(t, server, http.MethodPost, "/v1/tasks/task-1/result", map[string]any{
		"expectedVersion": progressed.EntityVersion,
		"reference":       "s3://reports/task-1.pdf",
	}, http.StatusOK, &result)
	var loadedResult rhinoq.TaskResult
	call(t, server, http.MethodGet, "/v1/tasks/task-1/result", nil, http.StatusOK, &loadedResult)
	if loadedResult.Reference != result.Reference ||
		loadedResult.EntityVersion != result.EntityVersion {
		t.Fatalf("result reference did not round-trip: %+v", loadedResult)
	}
}

// A worker written in any language should be able to do the whole cycle over
// HTTP without knowing anything about leases, retries or SQL.
func TestAgentRunsAJobEndToEnd(t *testing.T) {
	server := newAgentServer(t)

	var enqueued struct {
		JobID string `json:"jobId"`
	}
	call(t, server, http.MethodPost, "/v1/jobs", map[string]any{
		"queueName": "send-report", "jobName": "send-report", "payload": []byte(`{"reportId":"r-1"}`),
		"idempotencyKey": "report:r-1", "priority": 5,
	}, http.StatusCreated, &enqueued)
	if enqueued.JobID == "" {
		t.Fatal("enqueue must return a job id")
	}

	var claimed struct {
		Jobs []rhinoq.LeasedJob `json:"jobs"`
	}
	call(t, server, http.MethodPost, "/v1/claim", map[string]any{
		"worker": "python-worker-1", "limit": 5, "leaseForMs": 60000,
	}, http.StatusOK, &claimed)
	if len(claimed.Jobs) != 1 {
		t.Fatalf("expected one claimed job, got %d", len(claimed.Jobs))
	}
	leased := claimed.Jobs[0]
	if leased.Lease.Owner != "python-worker-1" || leased.Lease.Epoch != 1 {
		t.Fatalf("the claim must hand back a fencing token: %+v", leased.Lease)
	}
	if string(leased.Payload) != `{"reportId":"r-1"}` {
		t.Fatalf("payload did not survive the round trip: %s", leased.Payload)
	}

	var beat rhinoq.LeaseState
	call(t, server, http.MethodPost, "/v1/leases/heartbeat", map[string]any{
		"lease": leased.Lease, "extendMs": 60000,
	}, http.StatusOK, &beat)
	if beat.CancelRequested {
		t.Fatal("a job nobody cancelled must not report a cancellation")
	}

	call(t, server, http.MethodPost, "/v1/leases/complete", map[string]any{
		"lease": leased.Lease,
	}, http.StatusOK, nil)

	var counts struct {
		Counts map[string]int64 `json:"counts"`
	}
	call(t, server, http.MethodGet, "/v1/queues/send-report/counts", nil, http.StatusOK, &counts)
	if counts.Counts["succeeded"] != 1 {
		t.Fatalf("the job should be recorded as succeeded: %+v", counts.Counts)
	}

	var timeline struct {
		Attempts []rhinoq.AttemptEvent `json:"attempts"`
	}
	call(t, server, http.MethodGet, "/v1/jobs/"+enqueued.JobID+"/attempts", nil, http.StatusOK, &timeline)
	if len(timeline.Attempts) != 2 || timeline.Attempts[0].Kind != "claimed" ||
		timeline.Attempts[1].Kind != "succeeded" {
		t.Fatalf("the Agent must expose immutable execution evidence: %+v", timeline.Attempts)
	}
}

func TestAgentClaimCanBeRestrictedToRegisteredQueues(t *testing.T) {
	server := newAgentServer(t)
	call(t, server, http.MethodPost, "/v1/jobs", map[string]any{
		"queueName": "send-email", "jobName": "send-email", "payload": []byte("{}"),
	}, http.StatusCreated, nil)
	call(t, server, http.MethodPost, "/v1/jobs", map[string]any{
		"queueName": "resize-image", "jobName": "resize-image", "payload": []byte("{}"),
	}, http.StatusCreated, nil)

	var claimed struct {
		Jobs []rhinoq.LeasedJob `json:"jobs"`
	}
	call(t, server, http.MethodPost, "/v1/claim", map[string]any{
		"worker": "email-worker", "queueNames": []string{"send-email"},
		"limit": 5, "leaseForMs": 60000,
	}, http.StatusOK, &claimed)
	if len(claimed.Jobs) != 1 || claimed.Jobs[0].Job.JobName != "send-email" {
		t.Fatalf("claim must stay inside the worker's handler set: %+v", claimed.Jobs)
	}

	var counts struct {
		Counts map[string]int64 `json:"counts"`
	}
	call(t, server, http.MethodGet, "/v1/queues/resize-image/counts", nil, http.StatusOK, &counts)
	if counts.Counts["pending"] != 1 {
		t.Fatalf("unhandled queue must remain pending: %+v", counts.Counts)
	}
}

func TestAgentConfirmsAnExternalSignalEffectAfterTheHandlerReturns(t *testing.T) {
	server := newAgentServer(t)
	var enqueued struct {
		JobID string `json:"jobId"`
	}
	call(t, server, http.MethodPost, "/v1/jobs", map[string]any{
		"queueName": "create-video", "jobName": "create-video", "payload": []byte("{}"),
	}, http.StatusCreated, &enqueued)

	var claimed struct {
		Jobs []rhinoq.LeasedJob `json:"jobs"`
	}
	call(t, server, http.MethodPost, "/v1/claim", map[string]any{
		"worker": "video-worker", "queueNames": []string{"create-video"},
		"limit": 1, "leaseForMs": 60000,
	}, http.StatusOK, &claimed)
	if len(claimed.Jobs) != 1 {
		t.Fatalf("expected one claimed video job, got %d", len(claimed.Jobs))
	}
	lease := claimed.Jobs[0].Lease
	effect := rhinoq.EffectRequest{
		Name: "provider-video", Key: "video:1",
		Confirm: rhinoq.ConfirmExternalSignal,
	}

	call(t, server, http.MethodPost, "/v1/effects/begin", map[string]any{
		"lease": lease, "effect": effect,
	}, http.StatusOK, nil)
	var accepted rhinoq.EffectResult
	call(t, server, http.MethodPost, "/v1/effects/resolve", map[string]any{
		"lease": lease, "effect": effect,
		"reference": "request_1", "outcome": "succeeded",
	}, http.StatusOK, &accepted)
	if accepted.State != rhinoq.EffectPending {
		t.Fatalf("request acceptance must not confirm an external-signal effect: %+v", accepted)
	}

	var confirmed rhinoq.EffectResult
	call(t, server, http.MethodPost, "/v1/effects/confirm", map[string]any{
		"jobId": enqueued.JobID, "name": effect.Name, "key": effect.Key,
		"reference": "provider_event_1",
	}, http.StatusOK, &confirmed)
	if confirmed.State != rhinoq.EffectConfirmed ||
		confirmed.ExternalRef != "provider_event_1" {
		t.Fatalf("external evidence must confirm the pending effect: %+v", confirmed)
	}
}

func TestAgentUsesCamelCaseJobFieldsOnTheWire(t *testing.T) {
	server := newAgentServer(t)
	call(t, server, http.MethodPost, "/v1/jobs", map[string]any{
		"queueName": "send-email", "jobName": "send-email", "payload": []byte("{}"),
	}, http.StatusCreated, nil)

	status, raw := rawCall(t, server, http.MethodGet, "/v1/jobs?limit=1", nil, agentToken)
	if status != http.StatusOK {
		t.Fatalf("list jobs failed: %d\n%s", status, raw)
	}
	var response struct {
		Jobs []map[string]any `json:"jobs"`
	}
	if err := json.Unmarshal([]byte(raw), &response); err != nil {
		t.Fatal(err)
	}
	if len(response.Jobs) != 1 {
		t.Fatalf("expected one job: %s", raw)
	}
	if _, found := response.Jobs[0]["id"]; !found {
		t.Fatalf("Node SDK contract requires camelCase job fields: %s", raw)
	}
	if _, legacy := response.Jobs[0]["ID"]; legacy {
		t.Fatalf("legacy Go field names must not leak onto HTTP: %s", raw)
	}
}

// A second worker that presents a stale token must be refused, and the answer
// has to be machine-readable so an SDK can stop rather than retry.
func TestAgentRefusesStaleLeaseWithATypedError(t *testing.T) {
	server := newAgentServer(t)
	call(t, server, http.MethodPost, "/v1/jobs", map[string]any{
		"queueName": "charge", "jobName": "charge", "payload": []byte("{}"),
	}, http.StatusCreated, nil)

	var claimed struct {
		Jobs []rhinoq.LeasedJob `json:"jobs"`
	}
	call(t, server, http.MethodPost, "/v1/claim", map[string]any{
		"worker": "worker-1", "limit": 1, "leaseForMs": 60000,
	}, http.StatusOK, &claimed)
	stale := claimed.Jobs[0].Lease
	stale.Epoch--

	var failure struct {
		Error agent.ErrorBody `json:"error"`
	}
	call(t, server, http.MethodPost, "/v1/leases/complete", map[string]any{
		"lease": stale,
	}, http.StatusConflict, &failure)
	if failure.Error.Code != "RHINOQ_LEASE_LOST" || failure.Error.Retryable {
		t.Fatalf("a fenced write must be reported as a non-retryable conflict: %+v", failure.Error)
	}
	if !strings.Contains(failure.Error.Message, "What happened") {
		t.Fatalf("the error should explain itself to an operator:\n%s", failure.Error.Message)
	}
}

func TestAgentReportsOverCapacityWithRetryAfter(t *testing.T) {
	client := rhinoq.NewInMemory()
	if err := client.SetAdmission(context.Background(), "reports", rhinoq.AdmissionPolicy{
		MaxPending: 1, OnOverflow: rhinoq.OverflowReject, RetryAfter: 30 * time.Second,
	}); err != nil {
		t.Fatal(err)
	}
	server := newAgentServerFor(t, client)

	call(t, server, http.MethodPost, "/v1/jobs", map[string]any{
		"queueName": "reports", "jobName": "reports", "payload": []byte("{}"),
	}, http.StatusCreated, nil)

	var rejection struct {
		Error agent.ErrorBody `json:"error"`
	}
	call(t, server, http.MethodPost, "/v1/jobs", map[string]any{
		"queueName": "reports", "jobName": "reports", "payload": []byte("{}"),
	}, http.StatusTooManyRequests, &rejection)
	if rejection.Error.Code != "RHINOQ_QUEUE_OVER_CAPACITY" || !rejection.Error.Retryable {
		t.Fatalf("a full queue must tell the producer to come back: %+v", rejection.Error)
	}
	if rejection.Error.RetryAfterMs != 30000 {
		t.Fatalf("expected a 30s retry hint, got %dms", rejection.Error.RetryAfterMs)
	}
}

// The failure envelope is the cross-language contract: the SDK classifies, the
// engine decides.
func TestAgentAppliesRetryClassFromTheErrorEnvelope(t *testing.T) {
	server := newAgentServer(t)
	call(t, server, http.MethodPost, "/v1/jobs", map[string]any{
		"queueName": "sync", "jobName": "sync", "payload": []byte("{}"),
	}, http.StatusCreated, nil)
	var claimed struct {
		Jobs []rhinoq.LeasedJob `json:"jobs"`
	}
	call(t, server, http.MethodPost, "/v1/claim", map[string]any{
		"worker": "node-worker-1", "limit": 1, "leaseForMs": 60000,
	}, http.StatusOK, &claimed)

	var failed struct {
		Job         rhinoq.JobSummary `json:"job"`
		Fingerprint string            `json:"fingerprint"`
	}
	call(t, server, http.MethodPost, "/v1/leases/fail", map[string]any{
		"lease": claimed.Jobs[0].Lease,
		"queue": "sync",
		"error": map[string]any{
			"type": "UnsupportedUrlError", "retryClass": rhinoq.RetryPermanent,
			"message": "the video url is not supported", "language": "node",
		},
	}, http.StatusOK, &failed)
	if failed.Job.State != "dead" {
		t.Fatalf("a permanent error must not be retried: %+v", failed.Job)
	}
	if !strings.HasPrefix(failed.Fingerprint, "sha256:") {
		t.Fatalf("identical failures need a grouping key: %q", failed.Fingerprint)
	}
}

func TestAgentNegotiatesProtocolCapabilities(t *testing.T) {
	server := newAgentServer(t)

	var compatible agent.HandshakeResult
	call(t, server, http.MethodPost, "/v1/handshake", map[string]any{
		"protocolVersion": agent.ProtocolVersion,
		"capabilities":    []string{"claim", "heartbeat", "fencing", "cancel", "effect", "batch-claim", "queue-filter"},
		"payloadCodec":    "json", "language": "python",
	}, http.StatusOK, &compatible)
	if compatible.Result != agent.Compatible {
		t.Fatalf("a fully capable SDK must connect cleanly: %+v", compatible)
	}

	var degraded agent.HandshakeResult
	call(t, server, http.MethodPost, "/v1/handshake", map[string]any{
		"protocolVersion": agent.ProtocolVersion,
		"capabilities":    []string{"claim", "heartbeat", "fencing"},
	}, http.StatusOK, &degraded)
	if degraded.Result != agent.Degraded || len(degraded.Disabled) == 0 || degraded.Reason == "" {
		t.Fatalf("an SDK missing optional features must be told what is off: %+v", degraded)
	}

	var rejected agent.HandshakeResult
	call(t, server, http.MethodPost, "/v1/handshake", map[string]any{
		"protocolVersion": agent.ProtocolVersion,
		"capabilities":    []string{"claim"},
	}, http.StatusUpgradeRequired, &rejected)
	if rejected.Result != agent.Rejected || len(rejected.Missing) == 0 {
		t.Fatalf("an SDK that cannot fence must be refused: %+v", rejected)
	}

	var oldProtocol agent.HandshakeResult
	call(t, server, http.MethodPost, "/v1/handshake", map[string]any{
		"protocolVersion": "0.9",
		"capabilities":    []string{"claim", "heartbeat", "fencing"},
	}, http.StatusUpgradeRequired, &oldProtocol)
	if oldProtocol.Result != agent.Rejected {
		t.Fatalf("an incompatible protocol major must be refused: %+v", oldProtocol)
	}
}

func TestAgentSeparatesLivenessFromReadiness(t *testing.T) {
	client := rhinoq.NewInMemory()
	server := newAgentServerFor(t, client)

	if status, _ := rawCall(t, server, http.MethodGet, "/health/live", nil, ""); status != http.StatusOK {
		t.Fatalf("liveness must not need a token or a database, got %d", status)
	}
	if status, _ := rawCall(t, server, http.MethodGet, "/health/ready", nil, ""); status != http.StatusOK {
		t.Fatalf("readiness should pass on a healthy agent, got %d", status)
	}

	// Draining must fail readiness while liveness keeps passing: the pod should
	// leave rotation, not be restarted.
	server.Drain()
	if status, _ := rawCall(t, server, http.MethodGet, "/health/ready", nil, ""); status != http.StatusServiceUnavailable {
		t.Fatalf("a draining agent must fail readiness, got %d", status)
	}
	if status, _ := rawCall(t, server, http.MethodGet, "/health/live", nil, ""); status != http.StatusOK {
		t.Fatalf("a draining agent is still alive, got %d", status)
	}
}

func TestAgentRefusesRequestsWithoutAToken(t *testing.T) {
	server := newAgentServer(t)
	status, body := rawCall(t, server, http.MethodGet, "/v1/jobs?queue=any&limit=10", nil, "")
	if status != http.StatusUnauthorized {
		t.Fatalf("an unauthenticated read must be refused, got %d", status)
	}
	if !strings.Contains(body, "RHINOQ_UNAUTHORIZED") || !strings.Contains(body, "How to fix") {
		t.Fatalf("the refusal should say how to authenticate:\n%s", body)
	}
}

func TestAgentExportsPrometheusMetrics(t *testing.T) {
	server := newAgentServer(t)
	call(t, server, http.MethodPost, "/v1/jobs", map[string]any{
		"queueName": "metrics-demo", "jobName": "metrics-demo", "payload": []byte("{}"),
	}, http.StatusCreated, nil)

	status, body := rawCall(t, server, http.MethodGet, "/metrics", nil, agentToken)
	if status != http.StatusOK {
		t.Fatalf("metrics endpoint failed: %d", status)
	}
	for _, expected := range []string{
		"# TYPE rhinoq_jobs gauge",
		`rhinoq_jobs{state="pending"} 1`,
		"rhinoq_agent_ready 1",
		"rhinoq_build_info",
	} {
		if !strings.Contains(body, expected) {
			t.Fatalf("metrics output is missing %q:\n%s", expected, body)
		}
	}
}

func newAgentServer(t *testing.T) *agent.Server {
	t.Helper()
	return newAgentServerFor(t, rhinoq.NewInMemory())
}

func newAgentServerFor(t *testing.T, client *rhinoq.Client) *agent.Server {
	t.Helper()
	server, err := agent.New(agent.Config{Client: client, Token: agentToken})
	if err != nil {
		t.Fatal(err)
	}
	return server
}

func call(t *testing.T, server *agent.Server, method, path string, body any, wantStatus int, into any) {
	t.Helper()
	status, raw := rawCall(t, server, method, path, body, agentToken)
	if status != wantStatus {
		t.Fatalf("%s %s: expected status %d, got %d\n%s", method, path, wantStatus, status, raw)
	}
	if into == nil {
		return
	}
	if err := json.Unmarshal([]byte(raw), into); err != nil {
		t.Fatalf("%s %s: decode response: %v\n%s", method, path, err, raw)
	}
}

func rawCall(t *testing.T, server *agent.Server, method, path string, body any, token string) (int, string) {
	t.Helper()
	var reader *bytes.Reader
	if body != nil {
		encoded, err := json.Marshal(body)
		if err != nil {
			t.Fatal(err)
		}
		reader = bytes.NewReader(encoded)
	} else {
		reader = bytes.NewReader(nil)
	}
	request := httptest.NewRequest(method, path, reader)
	if token != "" {
		request.Header.Set("Authorization", "Bearer "+token)
	}
	recorder := httptest.NewRecorder()
	server.ServeHTTP(recorder, request)
	return recorder.Code, recorder.Body.String()
}
