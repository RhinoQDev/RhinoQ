package agent

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/madebyduy/RhinoQ/pkg/rhinoq"
)

const minTokenBytes = 32

// Config wires one Agent process.
type Config struct {
	Client *rhinoq.Client
	// Token authenticates every call except the liveness probe. It is required
	// unless AllowUnauthenticated is set, because an Agent without one lets
	// anybody enqueue, cancel and replay work.
	Token string
	// TaskCredentials are optional end-user polling/cancel credentials. They
	// cannot access worker/operator routes and are scoped to one Task owner.
	// The main Token remains an operator/runtime credential.
	TaskCredentials []TaskCredential
	// AllowUnauthenticated is an explicit opt-in for local development.
	AllowUnauthenticated bool
	// HeartbeatInterval is what the Agent tells SDKs to use for lease renewal.
	HeartbeatInterval time.Duration
	// MaxPayloadBytes bounds an enqueued payload.
	MaxPayloadBytes int
	// MaxRequestBytes bounds a request body.
	MaxRequestBytes int64
	// Version is reported by the build-info metric.
	Version string
	// RequestsPerSecond and RequestBurst bound one process. Deployments with
	// multiple replicas still need an edge/distributed limiter.
	RequestsPerSecond float64
	RequestBurst      int
	RepairRegistry    *rhinoq.RepairRegistry
}

type TaskCredential struct {
	OwnerID string `json:"ownerId"`
	Token   string `json:"token"`
}

type taskCredential struct {
	ownerID   string
	tokenHash [sha256.Size]byte
}

type taskPrincipal struct {
	ownerID  string
	operator bool
}

type taskPrincipalContextKey struct{}

// Server is the HTTP surface of a RhinoQ Agent.
type Server struct {
	client            *rhinoq.Client
	tokenHash         [sha256.Size]byte
	taskCredentials   []taskCredential
	open              bool
	heartbeatInterval time.Duration
	maxPayloadBytes   int
	maxRequestBytes   int64
	version           string
	limiter           *requestLimiter
	repairs           *rhinoq.RepairRegistry

	// draining flips on shutdown so readiness fails before liveness does: an
	// orchestrator should stop sending traffic, not restart the process.
	draining atomic.Bool
	handled  atomic.Int64
	failed   atomic.Int64
	mux      *http.ServeMux
}

func New(config Config) (*Server, error) {
	if config.Client == nil {
		return nil, errors.New("agent requires a rhinoq client")
	}
	if config.Token == "" && !config.AllowUnauthenticated {
		return nil, errors.New("agent requires a token; set AllowUnauthenticated only for local development")
	}
	if config.Token != "" && len(config.Token) < minTokenBytes {
		return nil, fmt.Errorf("agent token must be at least %d bytes", minTokenBytes)
	}
	operatorHash := sha256.Sum256([]byte(config.Token))
	credentials := make([]taskCredential, 0, len(config.TaskCredentials))
	for _, credential := range config.TaskCredentials {
		ownerID := strings.TrimSpace(credential.OwnerID)
		if ownerID == "" || len(credential.Token) < minTokenBytes {
			return nil, fmt.Errorf(
				"task credential requires a non-empty owner and token of at least %d bytes",
				minTokenBytes,
			)
		}
		tokenHash := sha256.Sum256([]byte(credential.Token))
		if config.Token != "" &&
			subtle.ConstantTimeCompare(tokenHash[:], operatorHash[:]) == 1 {
			return nil, errors.New("task credential must differ from the operator token")
		}
		for _, existing := range credentials {
			if subtle.ConstantTimeCompare(tokenHash[:], existing.tokenHash[:]) == 1 {
				return nil, errors.New("one task credential token cannot belong to multiple owners")
			}
		}
		credentials = append(credentials, taskCredential{ownerID: ownerID, tokenHash: tokenHash})
	}
	if config.HeartbeatInterval <= 0 {
		config.HeartbeatInterval = 10 * time.Second
	}
	if config.MaxPayloadBytes <= 0 {
		config.MaxPayloadBytes = 1 << 20
	}
	if config.MaxRequestBytes <= 0 {
		config.MaxRequestBytes = int64(config.MaxPayloadBytes) * 2
	}
	if config.Version == "" {
		config.Version = "0.1.0-dev"
	}
	if config.RequestsPerSecond <= 0 {
		config.RequestsPerSecond = 200
	}
	if config.RequestBurst <= 0 {
		config.RequestBurst = 400
	}
	server := &Server{
		client: config.Client, tokenHash: operatorHash,
		taskCredentials:   credentials,
		open:              config.AllowUnauthenticated,
		heartbeatInterval: config.HeartbeatInterval, maxPayloadBytes: config.MaxPayloadBytes,
		maxRequestBytes: config.MaxRequestBytes, version: config.Version,
		limiter: newRequestLimiter(config.RequestsPerSecond, config.RequestBurst),
		repairs: config.RepairRegistry,
	}
	server.routes()
	return server, nil
}

func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) { s.mux.ServeHTTP(w, r) }

// Drain marks the Agent as not ready while leaving it alive, so traffic stops
// arriving before the process goes away.
func (s *Server) Drain() { s.draining.Store(true) }

func (s *Server) routes() {
	mux := http.NewServeMux()

	// Liveness answers one question only: is this process running. Mixing it
	// with dependency checks turns a slow database into a restart loop
	// (specification 50.5).
	mux.HandleFunc("GET /health/live", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, map[string]string{"status": "alive"})
	})
	mux.HandleFunc("GET /health/ready", s.handleReady)
	mux.HandleFunc("GET /metrics", s.guard(s.handleMetrics))

	mux.HandleFunc("POST /v1/handshake", s.guard(s.handleHandshake))

	// Producer surface.
	mux.HandleFunc("POST /v1/jobs", s.guard(s.handleEnqueue))
	mux.HandleFunc("GET /v1/jobs", s.guard(s.handleListJobs))
	mux.HandleFunc("POST /v1/jobs/{id}/cancel", s.guard(s.handleCancel))
	mux.HandleFunc("POST /v1/jobs/{id}/replay", s.guard(s.handleReplay))
	mux.HandleFunc("GET /v1/jobs/{id}/audit", s.guard(s.handleAudit))
	mux.HandleFunc("GET /v1/jobs/{id}/attempts", s.guard(s.handleAttempts))

	// User-facing Task surface. GET is deliberately polling-first; realtime
	// delivery can be added later without changing the versioned snapshot.
	mux.HandleFunc("POST /v1/tasks", s.guard(s.handleCreateTask))
	mux.HandleFunc("GET /v1/tasks/{id}", s.taskGuard(s.handleGetTask))
	mux.HandleFunc("GET /v1/tasks/{id}/summary", s.taskGuard(s.handleGetTaskSummary))
	mux.HandleFunc("GET /v1/tasks/{id}/executions/page", s.taskGuard(s.handleListTaskExecutions))
	mux.HandleFunc("POST /v1/tasks/{id}/cancel", s.taskGuard(s.handleRequestTaskCancellation))
	mux.HandleFunc("POST /v1/tasks/{id}/state", s.guard(s.handleTransitionTask))
	mux.HandleFunc("POST /v1/tasks/{id}/cancellation", s.guard(s.handleResolveTaskCancellation))
	mux.HandleFunc("POST /v1/tasks/{id}/progress", s.guard(s.handleTaskProgress))
	mux.HandleFunc("GET /v1/tasks/{id}/result", s.taskGuard(s.handleGetTaskResult))
	mux.HandleFunc("GET /v1/tasks/{id}/execution-results", s.taskGuard(s.handleGetTaskExecutionResults))
	mux.HandleFunc("POST /v1/tasks/{id}/result", s.guard(s.handleAttachTaskResult))
	mux.HandleFunc("POST /v1/tasks/{id}/executions", s.guard(s.handleCreateTaskExecution))
	mux.HandleFunc("GET /v1/task-executions/lookup", s.guard(s.handleLookupTaskExecution))
	mux.HandleFunc("GET /v1/task-executions/{id}", s.guard(s.handleGetTaskExecution))
	mux.HandleFunc("POST /v1/task-executions/{id}/bind", s.guard(s.handleBindTaskExecution))
	mux.HandleFunc("POST /v1/task-executions/{id}/state", s.guard(s.handleTransitionTaskExecution))
	mux.HandleFunc("POST /v1/task-executions/{id}/result", s.guard(s.handleAttachTaskExecutionResult))

	// Worker surface: the four things an SDK does.
	mux.HandleFunc("POST /v1/claim", s.guard(s.handleClaim))
	mux.HandleFunc("POST /v1/leases/heartbeat", s.guard(s.handleHeartbeat))
	mux.HandleFunc("POST /v1/leases/complete", s.guard(s.handleComplete))
	mux.HandleFunc("POST /v1/leases/fail", s.guard(s.handleFail))
	mux.HandleFunc("POST /v1/leases/release", s.guard(s.handleRelease))
	mux.HandleFunc("POST /v1/effects/begin", s.guard(s.handleBeginEffect))
	mux.HandleFunc("POST /v1/effects/resolve", s.guard(s.handleResolveEffect))
	mux.HandleFunc("POST /v1/effects/confirm", s.guard(s.handleConfirmEffect))

	// Provider calls execute in the application process; these commands keep
	// identity, state transitions and retry authority in the Go engine.
	mux.HandleFunc("POST /v1/provider-operations", s.guard(s.handleBeginProviderOperation))
	mux.HandleFunc("GET /v1/provider-operations", s.guard(s.handleListProviderOperations))
	mux.HandleFunc("GET /v1/provider-operations/{id}", s.guard(s.handleGetProviderOperation))
	mux.HandleFunc("GET /v1/provider-operations/{id}/evidence", s.guard(s.handleProviderOperationEvidence))
	mux.HandleFunc("POST /v1/provider-operations/{id}/accept", s.guard(s.handleAcceptProviderOperation))
	mux.HandleFunc("POST /v1/provider-operations/{id}/resolve", s.guard(s.handleResolveProviderOperation))
	mux.HandleFunc("POST /v1/provider-operations/{id}/retry", s.guard(s.handleRetryProviderOperation))

	// Operator surface.
	mux.HandleFunc("GET /v1/queues/{name}/counts", s.guard(s.handleCounts))
	mux.HandleFunc("POST /v1/queues/{name}/pause", s.guard(s.handlePause))
	mux.HandleFunc("POST /v1/queues/{name}/resume", s.guard(s.handleResume))
	mux.HandleFunc("GET /v1/attention", s.guard(s.handleAttention))
	mux.HandleFunc("POST /v1/findings/observe", s.guard(s.handleObserveFinding))
	mux.HandleFunc("POST /v1/repairs", s.guard(s.handleProposeRepair))
	mux.HandleFunc("POST /v1/repairs/{id}/preview", s.guard(s.handlePreviewRepair))
	mux.HandleFunc("POST /v1/repairs/{id}/approve", s.guard(s.handleApproveRepair))
	mux.HandleFunc("POST /v1/repairs/{id}/execute", s.guard(s.handleExecuteRepair))
	mux.HandleFunc("GET /v1/findings", s.guard(s.handleListFindings))
	mux.HandleFunc("POST /v1/findings/transition", s.guard(s.handleTransitionFinding))
	mux.HandleFunc("GET /v1/findings/history", s.guard(s.handleFindingHistory))
	mux.HandleFunc("POST /v1/rules", s.guard(s.handleRegisterRule))
	mux.HandleFunc("GET /v1/rules", s.guard(s.handleListRules))
	mux.HandleFunc("GET /v1/rules/{id}", s.guard(s.handleGetRule))
	mux.HandleFunc("POST /v1/rules/{id}/explain", s.guard(s.handleExplainRule))
	mux.HandleFunc("POST /v1/rules/{id}/enable", s.guard(s.handleEnableRule))
	mux.HandleFunc("POST /v1/rules/{id}/disable", s.guard(s.handleDisableRule))
	mux.HandleFunc("POST /v1/rules/{id}/evaluate", s.guard(s.handleEvaluateRule))
	mux.HandleFunc("DELETE /v1/rules/{id}", s.guard(s.handleDeleteRule))

	s.mux = mux
}

func (s *Server) handleListProviderOperations(w http.ResponseWriter, r *http.Request) {
	limit := 100
	if raw := r.URL.Query().Get("limit"); raw != "" {
		parsed, err := strconv.Atoi(raw)
		if err != nil {
			s.fail(w, errors.New("provider operation limit must be an integer"))
			return
		}
		limit = parsed
	}
	if taskID := strings.TrimSpace(r.URL.Query().Get("taskId")); taskID != "" {
		items, err := s.client.ListProviderOperationsByTask(r.Context(), taskID, limit)
		if err != nil {
			s.fail(w, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"operations": items})
		return
	}
	before := time.Now().UTC()
	if raw := r.URL.Query().Get("before"); raw != "" {
		parsed, err := time.Parse(time.RFC3339Nano, raw)
		if err != nil {
			s.fail(w, errors.New("provider operation before must be RFC3339"))
			return
		}
		before = parsed
	}
	items, err := s.client.ListProviderOperationsNeedingAttention(r.Context(), rhinoq.ProviderOperationAttentionQuery{Before: before, Limit: limit})
	if err != nil {
		s.fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"operations": items})
}

func (s *Server) handleBeginProviderOperation(w http.ResponseWriter, r *http.Request) {
	var request rhinoq.ProviderOperationRequest
	if !decode(w, r, &request) {
		return
	}
	record, err := s.client.BeginProviderOperation(r.Context(), request)
	if err != nil {
		s.fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, record)
}

func (s *Server) handleGetProviderOperation(w http.ResponseWriter, r *http.Request) {
	record, err := s.client.GetProviderOperation(r.Context(), r.PathValue("id"))
	if err != nil {
		s.fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, record)
}

func (s *Server) handleProviderOperationEvidence(w http.ResponseWriter, r *http.Request) {
	items, err := s.client.ListProviderOperationEvidence(r.Context(), r.PathValue("id"))
	if err != nil {
		s.fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"evidence": items})
}

func (s *Server) handleAcceptProviderOperation(w http.ResponseWriter, r *http.Request) {
	var request struct {
		ProviderID string `json:"providerId"`
		Evidence   string `json:"evidence"`
	}
	if !decode(w, r, &request) {
		return
	}
	record, err := s.client.AcceptProviderOperation(r.Context(), r.PathValue("id"), request.ProviderID, request.Evidence)
	if err != nil {
		s.fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, record)
}

func (s *Server) handleResolveProviderOperation(w http.ResponseWriter, r *http.Request) {
	var decision rhinoq.ProviderConfirmation
	if !decode(w, r, &decision) {
		return
	}
	record, err := s.client.ResolveProviderOperation(r.Context(), r.PathValue("id"), decision)
	if err != nil {
		s.fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, record)
}

func (s *Server) handleRetryProviderOperation(w http.ResponseWriter, r *http.Request) {
	record, err := s.client.RetryProviderOperation(r.Context(), r.PathValue("id"))
	if err != nil {
		s.fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, record)
}

func (s *Server) guard(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !s.authorized(r) {
			status, body := unauthorized()
			writeJSON(w, status, errorResponse{Error: body})
			return
		}
		if !s.allow(w) {
			return
		}
		r.Body = http.MaxBytesReader(w, r.Body, s.maxRequestBytes)
		next(w, r)
	}
}

func (s *Server) taskGuard(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		principal, ok := s.taskPrincipal(r)
		if !ok {
			status, body := unauthorizedTask()
			writeJSON(w, status, errorResponse{Error: body})
			return
		}
		if !s.allow(w) {
			return
		}
		r.Body = http.MaxBytesReader(w, r.Body, s.maxRequestBytes)
		ctx := context.WithValue(r.Context(), taskPrincipalContextKey{}, principal)
		next(w, r.WithContext(ctx))
	}
}

func (s *Server) allow(w http.ResponseWriter) bool {
	ok, retry := s.limiter.Allow(time.Now())
	if ok {
		return true
	}
	seconds := int64(retry / time.Second)
	if seconds < 1 {
		seconds = 1
	}
	w.Header().Set("Retry-After", strconv.FormatInt(seconds, 10))
	writeJSON(w, http.StatusTooManyRequests, errorResponse{Error: ErrorBody{
		Code: "RHINOQ_RATE_LIMITED", Retryable: true, RetryAfterMs: retry.Milliseconds(),
		Message: "The RhinoQ Gateway request budget is exhausted. Retry after the advertised delay; lower polling/worker pressure or raise RHINOQ_AGENT_REQUESTS_PER_SECOND deliberately.",
	}})
	return false
}

type requestLimiter struct {
	mu                  sync.Mutex
	rate, tokens, burst float64
	last                time.Time
}

func newRequestLimiter(rate float64, burst int) *requestLimiter {
	return &requestLimiter{rate: rate, tokens: float64(burst), burst: float64(burst), last: time.Now()}
}
func (l *requestLimiter) Allow(now time.Time) (bool, time.Duration) {
	l.mu.Lock()
	defer l.mu.Unlock()
	elapsed := now.Sub(l.last).Seconds()
	if elapsed > 0 {
		l.tokens += elapsed * l.rate
		if l.tokens > l.burst {
			l.tokens = l.burst
		}
		l.last = now
	}
	if l.tokens >= 1 {
		l.tokens--
		return true, 0
	}
	retry := time.Duration((1 - l.tokens) / l.rate * float64(time.Second))
	if retry < time.Millisecond {
		retry = time.Millisecond
	}
	return false, retry
}

func (s *Server) authorized(r *http.Request) bool {
	if s.open {
		return true
	}
	header := r.Header.Get("Authorization")
	presented := strings.TrimPrefix(header, "Bearer ")
	if presented == header {
		presented = ""
	}
	presentedHash := sha256.Sum256([]byte(presented))
	return subtle.ConstantTimeCompare(presentedHash[:], s.tokenHash[:]) == 1
}

func (s *Server) taskPrincipal(r *http.Request) (taskPrincipal, bool) {
	if s.open {
		return taskPrincipal{operator: true}, true
	}
	presented := bearerToken(r)
	presentedHash := sha256.Sum256([]byte(presented))
	if subtle.ConstantTimeCompare(presentedHash[:], s.tokenHash[:]) == 1 {
		return taskPrincipal{operator: true}, true
	}
	for _, credential := range s.taskCredentials {
		if subtle.ConstantTimeCompare(presentedHash[:], credential.tokenHash[:]) == 1 {
			return taskPrincipal{ownerID: credential.ownerID}, true
		}
	}
	return taskPrincipal{}, false
}

func bearerToken(r *http.Request) string {
	header := r.Header.Get("Authorization")
	presented := strings.TrimPrefix(header, "Bearer ")
	if presented == header {
		return ""
	}
	return presented
}

func taskPrincipalFrom(ctx context.Context) taskPrincipal {
	principal, _ := ctx.Value(taskPrincipalContextKey{}).(taskPrincipal)
	return principal
}

func taskVisibleTo(principal taskPrincipal, ownerID string) bool {
	return principal.operator || (principal.ownerID != "" && principal.ownerID == ownerID)
}

func (s *Server) handleReady(w http.ResponseWriter, r *http.Request) {
	if s.draining.Load() {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{
			"status": "draining",
			"reason": "the agent is shutting down and should be taken out of rotation",
		})
		return
	}
	// Readiness has to touch the store: an Agent that cannot reach PostgreSQL
	// looks healthy from the outside and accepts work it cannot persist.
	if _, err := s.client.JobCounts(r.Context(), ""); err != nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{
			"status": "unready", "reason": "job store is unreachable",
		})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"status": "ready", "protocolVersion": ProtocolVersion,
	})
}

func (s *Server) handleHandshake(w http.ResponseWriter, r *http.Request) {
	var handshake Handshake
	if !decode(w, r, &handshake) {
		return
	}
	result := Negotiate(handshake, s.heartbeatInterval.Milliseconds(), s.maxPayloadBytes)
	status := http.StatusOK
	if result.Result == Rejected {
		status = http.StatusUpgradeRequired
	}
	writeJSON(w, status, result)
}

type enqueueRequest struct {
	QueueName      string `json:"queueName"`
	JobName        string `json:"jobName"`
	GroupKey       string `json:"groupKey,omitempty"`
	Payload        []byte `json:"payload"`
	IdempotencyKey string `json:"idempotencyKey,omitempty"`
	CorrelationID  string `json:"correlationId,omitempty"`
	Priority       int    `json:"priority,omitempty"`
	ResourceClass  string `json:"resourceClass,omitempty"`
	RunAfterMs     int64  `json:"runAfterMs,omitempty"`
}

func (s *Server) handleCreateTask(w http.ResponseWriter, r *http.Request) {
	var request rhinoq.TaskCreateRequest
	if !decode(w, r, &request) {
		return
	}
	snapshot, err := s.client.CreateTask(r.Context(), request)
	if err != nil {
		s.fail(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, snapshot)
}

func (s *Server) handleGetTask(w http.ResponseWriter, r *http.Request) {
	snapshot, err := s.client.GetTask(r.Context(), r.PathValue("id"))
	if err != nil {
		s.fail(w, err)
		return
	}
	if !taskVisibleTo(taskPrincipalFrom(r.Context()), snapshot.OwnerID) {
		s.fail(w, rhinoq.ErrTaskNotFound)
		return
	}
	writeJSON(w, http.StatusOK, snapshot)
}

func (s *Server) handleGetTaskSummary(w http.ResponseWriter, r *http.Request) {
	summary, err := s.client.GetTaskSummary(r.Context(), r.PathValue("id"))
	if err != nil {
		s.fail(w, err)
		return
	}
	if !taskVisibleTo(taskPrincipalFrom(r.Context()), summary.OwnerID) {
		s.fail(w, rhinoq.ErrTaskNotFound)
		return
	}
	writeJSON(w, http.StatusOK, summary)
}

func (s *Server) handleListTaskExecutions(w http.ResponseWriter, r *http.Request) {
	summary, err := s.client.GetTaskSummary(r.Context(), r.PathValue("id"))
	if err != nil {
		s.fail(w, err)
		return
	}
	if !taskVisibleTo(taskPrincipalFrom(r.Context()), summary.OwnerID) {
		s.fail(w, rhinoq.ErrTaskNotFound)
		return
	}
	limit := 100
	if raw := r.URL.Query().Get("limit"); raw != "" {
		value, parseErr := strconv.Atoi(raw)
		if parseErr != nil {
			s.fail(w, errors.New("execution page limit must be an integer"))
			return
		}
		limit = value
	}
	page, err := s.client.ListTaskExecutions(
		r.Context(), summary.ID, r.URL.Query().Get("cursor"), limit,
	)
	if err != nil {
		s.fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, page)
}

func (s *Server) handleGetTaskResult(w http.ResponseWriter, r *http.Request) {
	snapshot, err := s.client.GetTask(r.Context(), r.PathValue("id"))
	if err != nil {
		s.fail(w, err)
		return
	}
	if !taskVisibleTo(taskPrincipalFrom(r.Context()), snapshot.OwnerID) {
		s.fail(w, rhinoq.ErrTaskNotFound)
		return
	}
	result, err := s.client.GetTaskResult(r.Context(), r.PathValue("id"))
	if err != nil {
		s.fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, result)
}

type requestTaskCancellationRequest struct {
	ExpectedVersion int64 `json:"expectedVersion"`
}

func (s *Server) handleRequestTaskCancellation(w http.ResponseWriter, r *http.Request) {
	var request requestTaskCancellationRequest
	if !decode(w, r, &request) {
		return
	}
	snapshot, err := s.client.GetTask(r.Context(), r.PathValue("id"))
	if err != nil {
		s.fail(w, err)
		return
	}
	if !taskVisibleTo(taskPrincipalFrom(r.Context()), snapshot.OwnerID) {
		s.fail(w, rhinoq.ErrTaskNotFound)
		return
	}
	// The repeat-safety of this command lives in the Task domain, not here: a
	// read-then-skip at the edge would race any concurrent writer.
	snapshot, err = s.client.RequestTaskCancellation(
		r.Context(),
		snapshot.ID,
		request.ExpectedVersion,
	)
	if err != nil {
		s.fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, snapshot)
}

type attachTaskResultRequest struct {
	ExpectedVersion int64  `json:"expectedVersion"`
	Reference       string `json:"reference"`
}

func (s *Server) handleAttachTaskResult(w http.ResponseWriter, r *http.Request) {
	var request attachTaskResultRequest
	if !decode(w, r, &request) {
		return
	}
	result, err := s.client.AttachTaskResult(
		r.Context(),
		r.PathValue("id"),
		request.ExpectedVersion,
		request.Reference,
	)
	if err != nil {
		s.fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, result)
}

func (s *Server) handleCreateTaskExecution(w http.ResponseWriter, r *http.Request) {
	var request rhinoq.TaskExecutionCreateRequest
	if !decode(w, r, &request) {
		return
	}
	snapshot, err := s.client.CreateTaskExecution(
		r.Context(),
		r.PathValue("id"),
		request,
	)
	if err != nil {
		s.fail(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, snapshot)
}

func (s *Server) handleBindTaskExecution(w http.ResponseWriter, r *http.Request) {
	var request rhinoq.TaskExecutionBinding
	if !decode(w, r, &request) {
		return
	}
	snapshot, err := s.client.BindTaskExecution(
		r.Context(),
		r.PathValue("id"),
		request,
	)
	if err != nil {
		s.fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, snapshot)
}

func (s *Server) handleLookupTaskExecution(w http.ResponseWriter, r *http.Request) {
	record, err := s.client.LookupTaskExecution(
		r.Context(), r.URL.Query().Get("runtime"), r.URL.Query().Get("externalId"),
	)
	if err != nil {
		s.fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, record)
}

func (s *Server) handleGetTaskExecution(w http.ResponseWriter, r *http.Request) {
	record, err := s.client.GetTaskExecution(r.Context(), r.PathValue("id"))
	if err != nil {
		s.fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, record)
}

type transitionTaskExecutionRequest struct {
	ExpectedVersion int64  `json:"expectedVersion"`
	State           string `json:"state"`
	// Reason is honoured for the failed state only: it is the per-item
	// explanation a batch view shows next to the item that did not make it.
	Reason string `json:"reason,omitempty"`
}

func (s *Server) handleTransitionTaskExecution(w http.ResponseWriter, r *http.Request) {
	var request transitionTaskExecutionRequest
	if !decode(w, r, &request) {
		return
	}
	id := r.PathValue("id")
	var (
		snapshot rhinoq.TaskSnapshot
		err      error
	)
	if request.State == "failed" {
		snapshot, err = s.client.FailTaskExecution(
			r.Context(), id, request.ExpectedVersion, request.Reason,
		)
	} else {
		snapshot, err = s.client.TransitionTaskExecution(
			r.Context(), id, request.ExpectedVersion, request.State,
		)
	}
	if err != nil {
		s.fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, snapshot)
}

type attachTaskExecutionResultRequest struct {
	ExpectedVersion int64  `json:"expectedVersion"`
	Reference       string `json:"reference"`
}

func (s *Server) handleAttachTaskExecutionResult(w http.ResponseWriter, r *http.Request) {
	var request attachTaskExecutionResultRequest
	if !decode(w, r, &request) {
		return
	}
	snapshot, err := s.client.AttachTaskExecutionResult(
		r.Context(), r.PathValue("id"), request.ExpectedVersion, request.Reference,
	)
	if err != nil {
		s.fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, snapshot)
}

// handleGetTaskExecutionResults is owner-scoped for the same reason the Task
// result is: these references are storage locations, and one of them belonging
// to another tenant is exactly the leak this contract exists to prevent.
func (s *Server) handleGetTaskExecutionResults(w http.ResponseWriter, r *http.Request) {
	snapshot, err := s.client.GetTask(r.Context(), r.PathValue("id"))
	if err != nil {
		s.fail(w, err)
		return
	}
	if !taskVisibleTo(taskPrincipalFrom(r.Context()), snapshot.OwnerID) {
		s.fail(w, rhinoq.ErrTaskNotFound)
		return
	}
	results, err := s.client.GetTaskExecutionResults(r.Context(), snapshot.ID)
	if err != nil {
		s.fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, results)
}

type transitionTaskRequest struct {
	ExpectedVersion int64            `json:"expectedVersion"`
	State           rhinoq.TaskState `json:"state"`
}

func (s *Server) handleTransitionTask(w http.ResponseWriter, r *http.Request) {
	var request transitionTaskRequest
	if !decode(w, r, &request) {
		return
	}
	id := r.PathValue("id")
	var (
		snapshot rhinoq.TaskSnapshot
		err      error
	)
	switch request.State {
	case rhinoq.TaskQueued:
		snapshot, err = s.client.QueueTask(r.Context(), id, request.ExpectedVersion)
	case rhinoq.TaskRunning:
		snapshot, err = s.client.StartTask(r.Context(), id, request.ExpectedVersion)
	case rhinoq.TaskSucceeded:
		snapshot, err = s.client.CompleteTask(r.Context(), id, request.ExpectedVersion)
	case rhinoq.TaskFailed:
		snapshot, err = s.client.FailTask(r.Context(), id, request.ExpectedVersion)
	case rhinoq.TaskCancelRequested:
		snapshot, err = s.client.RequestTaskCancellation(r.Context(), id, request.ExpectedVersion)
	case rhinoq.TaskCancelled:
		snapshot, err = s.client.CancelTask(r.Context(), id, request.ExpectedVersion)
	default:
		err = fmt.Errorf("unsupported task target state %q", request.State)
	}
	if err != nil {
		s.fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, snapshot)
}

type taskProgressRequest struct {
	ExpectedVersion int64               `json:"expectedVersion"`
	Progress        rhinoq.TaskProgress `json:"progress"`
}

type resolveTaskCancellationRequest struct {
	ExpectedVersion int64  `json:"expectedVersion"`
	Status          string `json:"status"`
	Reason          string `json:"reason,omitempty"`
}

func (s *Server) handleResolveTaskCancellation(w http.ResponseWriter, r *http.Request) {
	var request resolveTaskCancellationRequest
	if !decode(w, r, &request) {
		return
	}
	snapshot, err := s.client.ResolveTaskCancellation(
		r.Context(),
		r.PathValue("id"),
		request.ExpectedVersion,
		request.Status,
		request.Reason,
	)
	if err != nil {
		s.fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, snapshot)
}

func (s *Server) handleTaskProgress(w http.ResponseWriter, r *http.Request) {
	var request taskProgressRequest
	if !decode(w, r, &request) {
		return
	}
	snapshot, err := s.client.ReportTaskProgress(
		r.Context(),
		r.PathValue("id"),
		request.ExpectedVersion,
		request.Progress,
	)
	if err != nil {
		s.fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, snapshot)
}

func (s *Server) handleEnqueue(w http.ResponseWriter, r *http.Request) {
	var request enqueueRequest
	if !decode(w, r, &request) {
		return
	}
	id, err := s.client.Enqueue(r.Context(), rhinoq.JobRequest{
		QueueName: request.QueueName, JobName: request.JobName,
		GroupKey: request.GroupKey, Payload: request.Payload,
		IdempotencyKey: request.IdempotencyKey, CorrelationID: request.CorrelationID,
		Priority: request.Priority, ResourceClass: request.ResourceClass,
		RunAfter: time.Duration(request.RunAfterMs) * time.Millisecond,
	})
	if err != nil {
		s.fail(w, err)
		return
	}
	s.handled.Add(1)
	writeJSON(w, http.StatusCreated, map[string]string{"jobId": id})
}

func (s *Server) handleCancel(w http.ResponseWriter, r *http.Request) {
	if err := s.client.Cancel(r.Context(), r.PathValue("id")); err != nil {
		s.fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "cancel requested"})
}

func (s *Server) handleListJobs(w http.ResponseWriter, r *http.Request) {
	query := r.URL.Query()
	jobs, err := s.client.ListJobs(r.Context(), rhinoq.JobQuery{
		QueueName: query.Get("queueName"),
		JobName:   query.Get("jobName"),
		GroupKey:  query.Get("groupKey"),
		States:    splitStates(query.Get("states")),
		Offset:    intParam(query.Get("offset"), 0),
		Limit:     intParam(query.Get("limit"), 50),
	})
	if err != nil {
		s.fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"jobs": jobs})
}

func (s *Server) handleCounts(w http.ResponseWriter, r *http.Request) {
	counts, err := s.client.JobCounts(r.Context(), r.PathValue("name"))
	if err != nil {
		s.fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"counts": counts})
}

func (s *Server) handlePause(w http.ResponseWriter, r *http.Request) {
	if err := s.client.Pause(r.Context(), r.PathValue("name")); err != nil {
		s.fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "paused"})
}

func (s *Server) handleResume(w http.ResponseWriter, r *http.Request) {
	if err := s.client.Resume(r.Context(), r.PathValue("name")); err != nil {
		s.fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "resumed"})
}

func (s *Server) handleAttention(w http.ResponseWriter, r *http.Request) {
	query := r.URL.Query()
	items, err := s.client.ListAttention(r.Context(), query.Get("queue"),
		intParam(query.Get("offset"), 0), intParam(query.Get("limit"), 50))
	if err != nil {
		s.fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": items})
}

func (s *Server) handleObserveFinding(w http.ResponseWriter, r *http.Request) {
	var observation rhinoq.FindingObservation
	if !decode(w, r, &observation) {
		return
	}
	record, err := s.client.ObserveFinding(r.Context(), observation)
	if err != nil {
		s.fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"finding": record})
}

func (s *Server) handleProposeRepair(w http.ResponseWriter, r *http.Request) {
	if !s.requireRepairRegistry(w) {
		return
	}
	var proposal rhinoq.RepairProposal
	if !decode(w, r, &proposal) {
		return
	}
	record, err := s.client.ProposeRepair(r.Context(), proposal)
	if err != nil {
		s.fail(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, record)
}

func (s *Server) handlePreviewRepair(w http.ResponseWriter, r *http.Request) {
	if !s.requireRepairRegistry(w) {
		return
	}
	record, err := s.client.PreviewRepair(r.Context(), r.PathValue("id"), s.repairs)
	if err != nil {
		s.fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, record)
}

func (s *Server) handleApproveRepair(w http.ResponseWriter, r *http.Request) {
	if !s.requireRepairRegistry(w) {
		return
	}
	var decision struct {
		Actor  string `json:"actor"`
		Reason string `json:"reason"`
	}
	if !decode(w, r, &decision) {
		return
	}
	record, err := s.client.ApproveRepair(r.Context(), r.PathValue("id"), decision.Actor, decision.Reason)
	if err != nil {
		s.fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, record)
}

func (s *Server) handleExecuteRepair(w http.ResponseWriter, r *http.Request) {
	if !s.requireRepairRegistry(w) {
		return
	}
	record, err := s.client.ExecuteRepair(r.Context(), r.PathValue("id"), s.repairs)
	if err != nil {
		s.fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, record)
}

func (s *Server) requireRepairRegistry(w http.ResponseWriter) bool {
	if s.repairs != nil {
		return true
	}
	writeJSON(w, http.StatusNotImplemented, errorResponse{Error: ErrorBody{
		Code: "REPAIR_CALLBACK_NOT_CONFIGURED", Retryable: false,
		Message: "no allowlisted application repair callback is configured; configure RHINOQ_REPAIR_CALLBACKS_JSON on the Gateway",
	}})
	return false
}

func (s *Server) handleListFindings(w http.ResponseWriter, r *http.Request) {
	query := r.URL.Query()
	records, err := s.client.ListFindings(r.Context(), rhinoq.FindingQuery{
		RuleID: query.Get("ruleId"), SubjectType: query.Get("subjectType"),
		SubjectID: query.Get("subjectId"), Statuses: splitStates(query.Get("statuses")),
		IncludeSuppressed: boolParam(query.Get("includeSuppressed")),
		Offset:            intParam(query.Get("offset"), 0), Limit: intParam(query.Get("limit"), 50),
	})
	if err != nil {
		s.fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"findings": records})
}

type transitionFindingRequest struct {
	Key        rhinoq.FindingKey        `json:"key"`
	Transition rhinoq.FindingTransition `json:"transition"`
}

func (s *Server) handleTransitionFinding(w http.ResponseWriter, r *http.Request) {
	var request transitionFindingRequest
	if !decode(w, r, &request) {
		return
	}
	record, err := s.client.TransitionFinding(r.Context(), request.Key, request.Transition)
	if err != nil {
		s.fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"finding": record})
}

func (s *Server) handleFindingHistory(w http.ResponseWriter, r *http.Request) {
	query := r.URL.Query()
	version := intParam(query.Get("invariantVersion"), -1)
	events, err := s.client.FindingHistory(r.Context(), rhinoq.FindingKey{
		RuleID: query.Get("ruleId"), SubjectType: query.Get("subjectType"),
		SubjectID: query.Get("subjectId"), InvariantVersion: version,
	}, intParam(query.Get("offset"), 0), intParam(query.Get("limit"), 50))
	if err != nil {
		s.fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"events": events})
}

type registerRuleRequest struct {
	ID          string    `json:"id"`
	Name        string    `json:"name"`
	Scope       string    `json:"scope"`
	SubjectType string    `json:"subjectType"`
	JobName     string    `json:"jobName,omitempty"`
	Query       string    `json:"query"`
	BaselineAt  time.Time `json:"baselineAt,omitempty"`
	EveryMs     int64     `json:"everyMs,omitempty"`
	WithinMs    int64     `json:"withinMs,omitempty"`
	MaxRows     int       `json:"maxRows,omitempty"`

	StatementTimeoutMs int64   `json:"statementTimeoutMs,omitempty"`
	MaxPlanCost        float64 `json:"maxPlanCost,omitempty"`
	MaxSeqScanRows     int64   `json:"maxSeqScanRows,omitempty"`
}

func (s *Server) handleRegisterRule(w http.ResponseWriter, r *http.Request) {
	var request registerRuleRequest
	if !decode(w, r, &request) {
		return
	}
	record, err := s.client.RegisterRule(r.Context(), rhinoq.RuleDefinition{
		ID: request.ID, Name: request.Name, Scope: request.Scope,
		SubjectType: request.SubjectType, JobName: request.JobName,
		Query: request.Query, BaselineAt: request.BaselineAt,
		Every:            time.Duration(request.EveryMs) * time.Millisecond,
		Within:           time.Duration(request.WithinMs) * time.Millisecond,
		MaxRows:          request.MaxRows,
		StatementTimeout: time.Duration(request.StatementTimeoutMs) * time.Millisecond,
		MaxPlanCost:      request.MaxPlanCost, MaxSeqScanRows: request.MaxSeqScanRows,
	})
	if err != nil {
		s.fail(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"rule": record})
}

func (s *Server) handleListRules(w http.ResponseWriter, r *http.Request) {
	query := r.URL.Query()
	records, err := s.client.ListRules(r.Context(), rhinoq.RuleQuery{
		Scope: query.Get("scope"), Statuses: splitStates(query.Get("statuses")),
		Offset: intParam(query.Get("offset"), 0), Limit: intParam(query.Get("limit"), 50),
	})
	if err != nil {
		s.fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"rules": records})
}

// handleGetRule reads one Rule without running Explain. A client about to
// re-register a Rule needs the current definition to show what its change
// would alter, and paying for a query plan to answer that would make the safe
// habit the expensive one.
func (s *Server) handleGetRule(w http.ResponseWriter, r *http.Request) {
	record, found, err := s.client.GetRule(r.Context(), r.PathValue("id"))
	if err != nil {
		s.fail(w, err)
		return
	}
	if !found {
		status, body := describe(rhinoq.ErrRuleNotFound)
		writeJSON(w, status, errorResponse{Error: body})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"rule": record})
}

func (s *Server) handleExplainRule(w http.ResponseWriter, r *http.Request) {
	record, explanation, err := s.client.ExplainRule(r.Context(), r.PathValue("id"))
	if err != nil {
		s.fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"rule": record, "explanation": explanation,
	})
}

func (s *Server) handleEnableRule(w http.ResponseWriter, r *http.Request) {
	record, explanation, err := s.client.EnableRule(r.Context(), r.PathValue("id"))
	if errors.Is(err, rhinoq.ErrRuleUnsafe) {
		status, body := describe(err)
		writeJSON(w, status, map[string]any{
			"rule": record, "explanation": explanation, "error": body,
		})
		return
	}
	if err != nil {
		s.fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"rule": record, "explanation": explanation,
	})
}

func (s *Server) handleDisableRule(w http.ResponseWriter, r *http.Request) {
	record, err := s.client.DisableRule(r.Context(), r.PathValue("id"))
	if err != nil {
		s.fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"rule": record})
}

// handleDeleteRule takes its arguments from the query string rather than a
// body: DELETE bodies are dropped by enough proxies that a purge flag hidden in
// one would eventually be lost in transit, and losing that flag turns a refusal
// into a silent discard of operator history.
func (s *Server) handleDeleteRule(w http.ResponseWriter, r *http.Request) {
	query := r.URL.Query()
	deletion, err := s.client.DeleteRule(r.Context(), rhinoq.RuleDeleteRequest{
		ID:            r.PathValue("id"),
		Version:       intParam(query.Get("version"), 0),
		PurgeFindings: query.Get("purgeFindings") == "true",
		DryRun:        query.Get("dryRun") == "true",
	})
	if err != nil {
		// The refusals carry the plan with them: an operator who is told the
		// Rule is still enabled also needs to know which version to disable.
		if errors.Is(err, rhinoq.ErrRuleEnabled) ||
			errors.Is(err, rhinoq.ErrRuleFindingsRemain) {
			status, body := describe(err)
			writeJSON(w, status, map[string]any{
				"deletion": deletion, "error": body,
			})
			return
		}
		s.fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"deletion": deletion})
}

type evaluateRuleRequest struct {
	SubjectID string `json:"subjectId,omitempty"`
	Cursor    string `json:"cursor,omitempty"`
}

func (s *Server) handleEvaluateRule(w http.ResponseWriter, r *http.Request) {
	var request evaluateRuleRequest
	if !decode(w, r, &request) {
		return
	}
	evaluation, err := s.client.EvaluateRule(
		r.Context(), r.PathValue("id"), request.SubjectID, request.Cursor,
	)
	if err != nil {
		s.fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, evaluation)
}

type replayRequest struct {
	Actor  string `json:"actor"`
	Reason string `json:"reason"`
}

func (s *Server) handleReplay(w http.ResponseWriter, r *http.Request) {
	var request replayRequest
	if !decode(w, r, &request) {
		return
	}
	job, audit, err := s.client.ReplayJob(r.Context(), r.PathValue("id"), request.Actor, request.Reason)
	if err != nil {
		s.fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"job": job, "audit": audit})
}

func (s *Server) handleAudit(w http.ResponseWriter, r *http.Request) {
	query := r.URL.Query()
	records, err := s.client.AuditTrail(r.Context(), r.PathValue("id"),
		intParam(query.Get("offset"), 0), intParam(query.Get("limit"), 50))
	if err != nil {
		s.fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"audit": records})
}

func (s *Server) handleAttempts(w http.ResponseWriter, r *http.Request) {
	query := r.URL.Query()
	events, err := s.client.AttemptTimeline(r.Context(), r.PathValue("id"),
		intParam(query.Get("offset"), 0), intParam(query.Get("limit"), 50))
	if err != nil {
		s.fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"attempts": events})
}

type claimRequest struct {
	Worker     string   `json:"worker"`
	Limit      int      `json:"limit,omitempty"`
	LeaseForMs int64    `json:"leaseForMs,omitempty"`
	QueueNames []string `json:"queueNames,omitempty"`
}

func (s *Server) handleClaim(w http.ResponseWriter, r *http.Request) {
	var request claimRequest
	if !decode(w, r, &request) {
		return
	}
	jobs, err := s.client.ClaimJobs(r.Context(), rhinoq.ClaimRequest{
		Worker: request.Worker, Limit: request.Limit,
		LeaseFor:   time.Duration(request.LeaseForMs) * time.Millisecond,
		QueueNames: request.QueueNames,
	})
	if err != nil {
		s.fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"jobs": jobs})
}

type leaseRequest struct {
	Lease    rhinoq.LeaseToken `json:"lease"`
	ExtendMs int64             `json:"extendMs,omitempty"`
}

func (s *Server) handleHeartbeat(w http.ResponseWriter, r *http.Request) {
	var request leaseRequest
	if !decode(w, r, &request) {
		return
	}
	extend := time.Duration(request.ExtendMs) * time.Millisecond
	state, err := s.client.Heartbeat(r.Context(), request.Lease, extend)
	if err != nil {
		s.fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, state)
}

func (s *Server) handleComplete(w http.ResponseWriter, r *http.Request) {
	var request leaseRequest
	if !decode(w, r, &request) {
		return
	}
	if err := s.client.CompleteJob(r.Context(), request.Lease); err != nil {
		s.fail(w, err)
		return
	}
	s.handled.Add(1)
	writeJSON(w, http.StatusOK, map[string]string{"state": "succeeded"})
}

func (s *Server) handleRelease(w http.ResponseWriter, r *http.Request) {
	var request leaseRequest
	if !decode(w, r, &request) {
		return
	}
	if err := s.client.ReleaseJob(r.Context(), request.Lease); err != nil {
		s.fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"state": "released"})
}

type failRequest struct {
	Lease rhinoq.LeaseToken    `json:"lease"`
	Error rhinoq.FailureReport `json:"error"`
	Queue string               `json:"queue,omitempty"`
}

func (s *Server) handleFail(w http.ResponseWriter, r *http.Request) {
	var request failRequest
	if !decode(w, r, &request) {
		return
	}
	// No unit conversion here: FailureReport owns the millisecond wire contract
	// so a second, divergent conversion cannot appear at a call site.
	summary, err := s.client.FailJob(r.Context(), request.Lease, request.Error)
	if err != nil {
		s.fail(w, err)
		return
	}
	s.failed.Add(1)
	writeJSON(w, http.StatusOK, map[string]any{
		"job":         summary,
		"fingerprint": request.Error.GroupingKey(request.Queue),
	})
}

type effectRequest struct {
	Lease     rhinoq.LeaseToken    `json:"lease"`
	Effect    rhinoq.EffectRequest `json:"effect"`
	Reference string               `json:"reference,omitempty"`
	Outcome   string               `json:"outcome,omitempty"`
}

type confirmEffectRequest struct {
	JobID     string `json:"jobId"`
	Name      string `json:"name"`
	Key       string `json:"key"`
	Reference string `json:"reference"`
}

func (s *Server) handleBeginEffect(w http.ResponseWriter, r *http.Request) {
	var request effectRequest
	if !decode(w, r, &request) {
		return
	}
	result, err := s.client.BeginEffect(r.Context(), request.Lease, request.Effect)
	if err != nil {
		s.fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, result)
}

func (s *Server) handleResolveEffect(w http.ResponseWriter, r *http.Request) {
	var request effectRequest
	if !decode(w, r, &request) {
		return
	}
	outcome := rhinoq.EffectOutcome(request.Outcome)
	if outcome == "" {
		outcome = rhinoq.EffectSucceeded
	}
	result, err := s.client.ResolveEffect(r.Context(), request.Lease, request.Effect, request.Reference, outcome)
	if err != nil {
		s.fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, result)
}

func (s *Server) handleConfirmEffect(w http.ResponseWriter, r *http.Request) {
	var request confirmEffectRequest
	if !decode(w, r, &request) {
		return
	}
	if request.JobID == "" || request.Name == "" || request.Key == "" || request.Reference == "" {
		s.fail(w, errors.New("effect confirmation requires jobId, name, key and reference"))
		return
	}
	result, err := s.client.ConfirmEffect(
		r.Context(),
		request.JobID,
		request.Name,
		request.Key,
		request.Reference,
	)
	if err != nil {
		s.fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, result)
}

func (s *Server) fail(w http.ResponseWriter, err error) {
	status, body := describe(err)
	writeJSON(w, status, errorResponse{Error: body})
}

func decode(w http.ResponseWriter, r *http.Request, target any) bool {
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		writeJSON(w, http.StatusBadRequest, errorResponse{Error: ErrorBody{
			Code:    "RHINOQ_INVALID_REQUEST",
			Message: "the request body must be valid JSON and match the endpoint schema",
		}})
		return false
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		writeJSON(w, http.StatusBadRequest, errorResponse{Error: ErrorBody{
			Code:    "RHINOQ_INVALID_REQUEST",
			Message: "the request body must contain exactly one JSON value",
		}})
		return false
	}
	return true
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

func splitStates(raw string) []string {
	if strings.TrimSpace(raw) == "" {
		return nil
	}
	parts := strings.Split(raw, ",")
	states := make([]string, 0, len(parts))
	for _, part := range parts {
		if trimmed := strings.TrimSpace(part); trimmed != "" {
			states = append(states, trimmed)
		}
	}
	return states
}

func intParam(raw string, fallback int) int {
	if raw == "" {
		return fallback
	}
	value, err := strconv.Atoi(raw)
	if err != nil {
		return fallback
	}
	return value
}

func boolParam(raw string) bool {
	value, err := strconv.ParseBool(raw)
	return err == nil && value
}
