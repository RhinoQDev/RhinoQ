package agent

import (
	"crypto/subtle"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"sync/atomic"
	"time"

	"github.com/rhinoq/rhinoq/pkg/rhinoq"
)

// Config wires one Agent process.
type Config struct {
	Client *rhinoq.Client
	// Token authenticates every call except the liveness probe. It is required
	// unless AllowUnauthenticated is set, because an Agent without one lets
	// anybody enqueue, cancel and replay work.
	Token string
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
}

// Server is the HTTP surface of a RhinoQ Agent.
type Server struct {
	client            *rhinoq.Client
	token             string
	open              bool
	heartbeatInterval time.Duration
	maxPayloadBytes   int
	maxRequestBytes   int64
	version           string

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
	server := &Server{
		client: config.Client, token: config.Token, open: config.AllowUnauthenticated,
		heartbeatInterval: config.HeartbeatInterval, maxPayloadBytes: config.MaxPayloadBytes,
		maxRequestBytes: config.MaxRequestBytes, version: config.Version,
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

	// Worker surface: the four things an SDK does.
	mux.HandleFunc("POST /v1/claim", s.guard(s.handleClaim))
	mux.HandleFunc("POST /v1/leases/heartbeat", s.guard(s.handleHeartbeat))
	mux.HandleFunc("POST /v1/leases/complete", s.guard(s.handleComplete))
	mux.HandleFunc("POST /v1/leases/fail", s.guard(s.handleFail))
	mux.HandleFunc("POST /v1/leases/release", s.guard(s.handleRelease))
	mux.HandleFunc("POST /v1/effects/begin", s.guard(s.handleBeginEffect))
	mux.HandleFunc("POST /v1/effects/resolve", s.guard(s.handleResolveEffect))

	// Operator surface.
	mux.HandleFunc("GET /v1/queues/{name}/counts", s.guard(s.handleCounts))
	mux.HandleFunc("POST /v1/queues/{name}/pause", s.guard(s.handlePause))
	mux.HandleFunc("POST /v1/queues/{name}/resume", s.guard(s.handleResume))
	mux.HandleFunc("GET /v1/attention", s.guard(s.handleAttention))
	mux.HandleFunc("POST /v1/findings/observe", s.guard(s.handleObserveFinding))
	mux.HandleFunc("GET /v1/findings", s.guard(s.handleListFindings))
	mux.HandleFunc("POST /v1/findings/transition", s.guard(s.handleTransitionFinding))
	mux.HandleFunc("GET /v1/findings/history", s.guard(s.handleFindingHistory))
	mux.HandleFunc("POST /v1/rules", s.guard(s.handleRegisterRule))
	mux.HandleFunc("GET /v1/rules", s.guard(s.handleListRules))
	mux.HandleFunc("POST /v1/rules/{id}/explain", s.guard(s.handleExplainRule))
	mux.HandleFunc("POST /v1/rules/{id}/enable", s.guard(s.handleEnableRule))
	mux.HandleFunc("POST /v1/rules/{id}/disable", s.guard(s.handleDisableRule))
	mux.HandleFunc("POST /v1/rules/{id}/evaluate", s.guard(s.handleEvaluateRule))

	s.mux = mux
}

func (s *Server) guard(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !s.authorized(r) {
			status, body := unauthorized()
			writeJSON(w, status, errorResponse{Error: body})
			return
		}
		r.Body = http.MaxBytesReader(w, r.Body, s.maxRequestBytes)
		next(w, r)
	}
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
	return subtle.ConstantTimeCompare([]byte(presented), []byte(s.token)) == 1
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
			"status": "unready", "reason": "job store is unreachable: " + err.Error(),
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
	Name           string `json:"name"`
	Payload        []byte `json:"payload"`
	IdempotencyKey string `json:"idempotencyKey,omitempty"`
	CorrelationID  string `json:"correlationId,omitempty"`
	Priority       int    `json:"priority,omitempty"`
	Class          string `json:"class,omitempty"`
	RunAfterMs     int64  `json:"runAfterMs,omitempty"`
}

func (s *Server) handleEnqueue(w http.ResponseWriter, r *http.Request) {
	var request enqueueRequest
	if !decode(w, r, &request) {
		return
	}
	id, err := s.client.Enqueue(r.Context(), rhinoq.JobRequest{
		Name: request.Name, Payload: request.Payload,
		IdempotencyKey: request.IdempotencyKey, CorrelationID: request.CorrelationID,
		Priority: request.Priority, Class: request.Class,
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
		Queue:  query.Get("queue"),
		States: splitStates(query.Get("states")),
		Offset: intParam(query.Get("offset"), 0),
		Limit:  intParam(query.Get("limit"), 50),
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
	Worker     string `json:"worker"`
	Limit      int    `json:"limit,omitempty"`
	LeaseForMs int64  `json:"leaseForMs,omitempty"`
}

func (s *Server) handleClaim(w http.ResponseWriter, r *http.Request) {
	var request claimRequest
	if !decode(w, r, &request) {
		return
	}
	jobs, err := s.client.ClaimJobs(r.Context(), rhinoq.ClaimRequest{
		Worker: request.Worker, Limit: request.Limit,
		LeaseFor: time.Duration(request.LeaseForMs) * time.Millisecond,
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
	request.Error.RetryAfter = time.Duration(request.Error.RetryAfter) * time.Millisecond
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
			Message: fmt.Sprintf("the request body could not be read: %v", err),
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
