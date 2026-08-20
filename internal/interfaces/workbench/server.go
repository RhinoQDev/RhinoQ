package workbench

import (
	"embed"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"net"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"time"
)

//go:embed static/*
var assets embed.FS

type Options struct {
	Version  string
	Operator Operator
}

type server struct {
	reader   Reader
	static   http.Handler
	version  string
	operator Operator
}

func NewHandler(reader Reader, options Options) (http.Handler, error) {
	if reader == nil {
		return nil, errors.New("workbench reader is required")
	}
	public, err := fs.Sub(assets, "static")
	if err != nil {
		return nil, err
	}
	s := &server{
		reader:   reader,
		static:   http.FileServer(http.FS(public)),
		version:  options.Version,
		operator: options.Operator,
	}
	return securityHeaders(http.HandlerFunc(s.serveHTTP)), nil
}

func (s *server) serveHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead && r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method_not_allowed", "unsupported Workbench method")
		return
	}
	if !sameOrigin(r) {
		writeError(w, http.StatusForbidden, "cross_origin_request", "Workbench only accepts same-origin browser requests")
		return
	}
	if r.Method == http.MethodPost {
		s.action(w, r)
		return
	}
	switch {
	case r.URL.Path == "/healthz":
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		w.Header().Set("Cache-Control", "no-store")
		writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
	case r.URL.Path == "/api/v1/snapshot":
		s.snapshot(w, r)
	case r.URL.Path == "/api/v1/stream":
		s.stream(w, r)
	case strings.HasPrefix(r.URL.Path, "/api/v1/rules/") && strings.HasSuffix(r.URL.Path, "/test"):
		s.ruleTest(w, r)
	case r.URL.Path == "/api/v1/bulk/preview":
		s.bulkPreview(w, r)
	case r.URL.Path == "/api/v1/recurring-schedules":
		s.recurringSchedules(w, r)
	case strings.HasPrefix(r.URL.Path, "/api/v1/subjects/"):
		s.subjectDetail(w, r)
	case strings.HasPrefix(r.URL.Path, "/api/v1/jobs/"):
		s.jobDetail(w, r)
	case strings.HasPrefix(r.URL.Path, "/api/"):
		writeError(w, http.StatusNotFound, "not_found", "API endpoint not found")
	default:
		s.static.ServeHTTP(w, r)
	}
}

func (s *server) snapshot(w http.ResponseWriter, r *http.Request) {
	query, err := parseQuery(r.URL.Query())
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid_query", err.Error())
		return
	}
	ctx := r.Context()
	snapshot, err := s.reader.Snapshot(ctx, query)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "snapshot_failed", err.Error())
		return
	}
	if snapshot.Product == "" {
		snapshot.Product = "RhinoQ Workbench"
	}
	if snapshot.Version == "" {
		snapshot.Version = s.version
	}
	if snapshot.GeneratedAt.IsZero() {
		snapshot.GeneratedAt = time.Now().UTC()
	}
	snapshot.Source.ReadOnly = s.operator == nil
	snapshot.Capabilities.Realtime = true
	snapshot.Capabilities.BulkPreview = true
	_, snapshot.Capabilities.BulkActions = s.operator.(BulkOperator)
	_, snapshot.Capabilities.RuleTest = s.reader.(RuleTester)
	snapshot.Capabilities.TaskProgress = hasTaskProgress(snapshot)
	if snapshot.Limits == nil {
		snapshot.Limits = map[string]int{"jobs": query.Limit}
	}
	normalizeSnapshot(&snapshot)
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusOK, snapshot)
}

func hasTaskProgress(snapshot Snapshot) bool {
	for _, job := range snapshot.Jobs {
		if job.Progress.HasData {
			return true
		}
	}
	return false
}

// stream provides an SSE delivery path for bounded snapshots. PostgreSQL (or
// another Reader) remains authoritative; this endpoint only re-reads the same
// query and emits a frame when its JSON changes. A polling fallback remains
// correct when the stream is unavailable.
func (s *server) stream(w http.ResponseWriter, r *http.Request) {
	query, err := parseQuery(r.URL.Query())
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid_query", err.Error())
		return
	}
	flusher, ok := w.(http.Flusher)
	if !ok {
		writeError(w, http.StatusNotImplemented, "stream_unsupported", "streaming is unavailable for this response writer")
		return
	}
	w.Header().Set("Content-Type", "text/event-stream; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("X-Accel-Buffering", "no")
	last := ""
	ticker := time.NewTicker(4 * time.Second)
	defer ticker.Stop()
	heartbeat := time.NewTicker(15 * time.Second)
	defer heartbeat.Stop()
	write := func() bool {
		snapshot, readErr := s.reader.Snapshot(r.Context(), query)
		if readErr != nil {
			_, _ = fmt.Fprintf(w, "event: error\ndata: %s\n\n", mustJSON(map[string]string{"message": readErr.Error()}))
			flusher.Flush()
			return true
		}
		if snapshot.Product == "" {
			snapshot.Product = "RhinoQ Workbench"
		}
		if snapshot.Version == "" {
			snapshot.Version = s.version
		}
		if snapshot.GeneratedAt.IsZero() {
			snapshot.GeneratedAt = time.Now().UTC()
		}
		snapshot.Source.ReadOnly = s.operator == nil
		snapshot.Capabilities.Realtime = true
		snapshot.Capabilities.BulkPreview = true
		_, snapshot.Capabilities.BulkActions = s.operator.(BulkOperator)
		_, snapshot.Capabilities.RuleTest = s.reader.(RuleTester)
		snapshot.Capabilities.TaskProgress = hasTaskProgress(snapshot)
		normalizeSnapshot(&snapshot)
		encoded := mustJSON(snapshot)
		if encoded == last {
			return true
		}
		last = encoded
		_, _ = fmt.Fprintf(w, "event: snapshot\ndata: %s\n\n", encoded)
		flusher.Flush()
		return true
	}
	if !write() {
		return
	}
	for {
		select {
		case <-r.Context().Done():
			return
		case <-ticker.C:
			if !write() {
				return
			}
		case <-heartbeat.C:
			_, _ = fmt.Fprint(w, ": heartbeat\n\n")
			flusher.Flush()
		}
	}
}

func mustJSON(value any) string {
	encoded, err := json.Marshal(value)
	if err != nil {
		return `{"error":"serialization_failed"}`
	}
	return string(encoded)
}

func (s *server) action(w http.ResponseWriter, r *http.Request) {
	if s.operator == nil {
		writeError(w, http.StatusMethodNotAllowed, "actions_disabled", "This Workbench has no application action callbacks registered")
		return
	}
	path := strings.Trim(r.URL.Path, "/")
	switch {
	case strings.HasPrefix(path, "api/v1/subjects/") && strings.HasSuffix(path, "/recheck"):
		s.recheck(w, r)
	case path == "api/v1/repairs":
		s.proposeRepair(w, r)
	case path == "api/v1/bulk/preview":
		s.bulkPreview(w, r)
	case strings.HasPrefix(path, "api/v1/bulk/"):
		s.bulkAction(w, r)
	case strings.HasPrefix(path, "api/v1/rules/") && strings.HasSuffix(path, "/test"):
		s.ruleTest(w, r)
	case strings.HasPrefix(path, "api/v1/repairs/"):
		s.repairAction(w, r)
	case strings.HasPrefix(path, "api/v1/recurring-schedules/"):
		s.recurringScheduleAction(w, r)
	default:
		writeError(w, http.StatusNotFound, "not_found", "Workbench action endpoint not found")
	}
}

func (s *server) bulkPreview(w http.ResponseWriter, r *http.Request) {
	var request BulkActionRequest
	if !decodeAction(w, r, &request) {
		return
	}
	request.Action = strings.TrimSpace(request.Action)
	if request.Action == "" {
		request.Action = "recheck"
	}
	if request.Action != "recheck" || len(request.JobIDs) == 0 || len(request.JobIDs) > 100 {
		writeError(w, http.StatusBadRequest, "invalid_bulk_request", "select 1 to 100 jobs and use the recheck action")
		return
	}
	if operator, ok := s.operator.(BulkOperator); ok {
		plan, err := operator.PreviewBulk(r.Context(), request)
		if err != nil {
			writeError(w, http.StatusUnprocessableEntity, "bulk_preview_failed", err.Error())
			return
		}
		writeJSON(w, http.StatusOK, normalizeBulkPlan(plan, request))
		return
	}
	plan := BulkPlan{ID: fmt.Sprintf("bulk_preview_%d", time.Now().UnixNano()), Action: request.Action, State: "previewed", Version: 1}
	seen := make(map[string]struct{}, len(request.JobIDs))
	for _, id := range request.JobIDs {
		id = strings.TrimSpace(id)
		if id == "" {
			continue
		}
		if _, exists := seen[id]; exists {
			continue
		}
		seen[id] = struct{}{}
		plan.Total++
		detail, err := s.reader.JobDetail(r.Context(), id)
		if err != nil {
			plan.Blocked = append(plan.Blocked, BulkClassification{JobID: id, Reason: "job evidence is unavailable"})
			continue
		}
		if detail.Job.State == "blocked" || detail.Job.State == "dead" || detail.Job.State == "cancelled" {
			plan.Blocked = append(plan.Blocked, BulkClassification{JobID: id, Reason: "terminal state requires an explicit recovery decision"})
			continue
		}
		uncertain := false
		for _, effect := range detail.Effects {
			if effect.State == "pending" || effect.State == "uncertain" {
				uncertain = true
				break
			}
		}
		if uncertain {
			plan.Uncertain = append(plan.Uncertain, BulkClassification{JobID: id, Reason: "an external effect is not confirmed"})
		} else {
			plan.Safe = append(plan.Safe, BulkClassification{JobID: id, Reason: "no unresolved effect in the bounded evidence"})
		}
	}
	writeJSON(w, http.StatusOK, normalizeBulkPlan(plan, request))
}

func (s *server) bulkAction(w http.ResponseWriter, r *http.Request) {
	operator, ok := s.operator.(BulkOperator)
	if !ok {
		writeError(w, http.StatusMethodNotAllowed, "bulk_actions_disabled", "bulk actions require an application BulkOperator and --actions")
		return
	}
	rest := strings.TrimPrefix(strings.Trim(r.URL.Path, "/"), "api/v1/bulk/")
	id, verb, found := strings.Cut(rest, "/")
	if !found || strings.TrimSpace(id) == "" {
		writeError(w, http.StatusBadRequest, "invalid_bulk_plan", "bulk plan id and action are required")
		return
	}
	var plan BulkPlan
	var err error
	switch verb {
	case "approve":
		var request struct {
			Actor  string `json:"actor"`
			Reason string `json:"reason"`
		}
		if !decodeAction(w, r, &request) {
			return
		}
		plan, err = operator.ApproveBulk(r.Context(), id, request.Actor, request.Reason)
	case "execute":
		if !decodeOptionalAction(w, r) {
			return
		}
		plan, err = operator.ExecuteBulk(r.Context(), id)
	default:
		writeError(w, http.StatusNotFound, "not_found", "bulk action not found")
		return
	}
	if err != nil {
		writeError(w, http.StatusUnprocessableEntity, "bulk_action_failed", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, plan)
}

func normalizeBulkPlan(plan BulkPlan, request BulkActionRequest) BulkPlan {
	if plan.ID == "" {
		plan.ID = fmt.Sprintf("bulk_%d", time.Now().UnixNano())
	}
	if plan.Action == "" {
		plan.Action = request.Action
	}
	if plan.State == "" {
		plan.State = "previewed"
	}
	if plan.Total == 0 {
		plan.Total = len(plan.Safe) + len(plan.Uncertain) + len(plan.Blocked)
	}
	if plan.Safe == nil {
		plan.Safe = []BulkClassification{}
	}
	if plan.Uncertain == nil {
		plan.Uncertain = []BulkClassification{}
	}
	if plan.Blocked == nil {
		plan.Blocked = []BulkClassification{}
	}
	return plan
}

func (s *server) ruleTest(w http.ResponseWriter, r *http.Request) {
	tester, ok := s.reader.(RuleTester)
	if !ok {
		writeError(w, http.StatusNotImplemented, "rule_test_unavailable", "this Workbench source has no registered Rule tester")
		return
	}
	rest := strings.TrimPrefix(r.URL.Path, "/api/v1/rules/")
	ruleID := strings.TrimSuffix(rest, "/test")
	ruleID, err := url.PathUnescape(ruleID)
	if err != nil || strings.TrimSpace(ruleID) == "" {
		writeError(w, http.StatusBadRequest, "invalid_rule", "rule id is required")
		return
	}
	var request struct {
		SubjectID string `json:"subjectId"`
	}
	if !decodeAction(w, r, &request) || strings.TrimSpace(request.SubjectID) == "" {
		if strings.TrimSpace(request.SubjectID) == "" {
			writeError(w, http.StatusBadRequest, "invalid_subject", "subject id is required")
		}
		return
	}
	result, err := tester.TestRule(r.Context(), ruleID, strings.TrimSpace(request.SubjectID))
	if err != nil {
		writeError(w, http.StatusUnprocessableEntity, "rule_test_failed", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, result)
}

func (s *server) recurringSchedules(w http.ResponseWriter, r *http.Request) {
	reader, ok := s.reader.(RecurringReader)
	if !ok {
		writeError(w, http.StatusNotImplemented, "recurring_not_configured", "Recurring schedule reader is not configured")
		return
	}
	tenantID := strings.TrimSpace(r.URL.Query().Get("tenantId"))
	limit := DefaultLimit
	if raw := r.URL.Query().Get("limit"); raw != "" {
		parsed, err := strconv.Atoi(raw)
		if err != nil || parsed < 1 || parsed > MaxLimit {
			writeError(w, http.StatusBadRequest, "invalid_limit", "limit must be between 1 and 250")
			return
		}
		limit = parsed
	}
	items, err := reader.ListRecurringSchedules(r.Context(), tenantID, limit)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "recurring_read_failed", err.Error())
		return
	}
	if items == nil {
		items = []RecurringSchedule{}
	}
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusOK, map[string]any{"schedules": items})
}

func (s *server) recurringScheduleAction(w http.ResponseWriter, r *http.Request) {
	operator, ok := s.operator.(RecurringOperator)
	if !ok {
		writeError(w, http.StatusMethodNotAllowed, "recurring_actions_disabled", "Recurring schedule actions are not configured")
		return
	}
	rest := strings.TrimPrefix(strings.Trim(r.URL.Path, "/"), "api/v1/recurring-schedules/")
	id, verb, found := strings.Cut(rest, "/")
	if !found || strings.TrimSpace(id) == "" || (verb != "pause" && verb != "resume") {
		writeError(w, http.StatusBadRequest, "invalid_recurring_action", "schedule id and pause/resume action are required")
		return
	}
	id, err := url.PathUnescape(id)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid_schedule", "schedule id is invalid")
		return
	}
	var request struct {
		TenantID string `json:"tenantId"`
		Version  int64  `json:"version"`
	}
	if !decodeAction(w, r, &request) {
		return
	}
	record, err := operator.SetRecurringScheduleEnabled(r.Context(), request.TenantID, id, request.Version, verb == "resume")
	if err != nil {
		writeError(w, http.StatusUnprocessableEntity, "recurring_action_failed", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, record)
}

func (s *server) recheck(w http.ResponseWriter, r *http.Request) {
	rest := strings.TrimSuffix(strings.TrimPrefix(strings.Trim(r.URL.Path, "/"), "api/v1/subjects/"), "/recheck")
	parts := strings.Split(rest, "/")
	if len(parts) != 2 {
		writeError(w, http.StatusBadRequest, "invalid_subject", "subject type and id are required")
		return
	}
	subjectType, e1 := url.PathUnescape(parts[0])
	subjectID, e2 := url.PathUnescape(parts[1])
	var request struct {
		RuleID string `json:"ruleId"`
	}
	if e1 != nil || e2 != nil || !decodeAction(w, r, &request) || strings.TrimSpace(request.RuleID) == "" {
		if e1 != nil || e2 != nil {
			writeError(w, http.StatusBadRequest, "invalid_subject", "subject path is invalid")
		}
		return
	}
	result, err := s.operator.Recheck(r.Context(), SubjectRef{Type: subjectType, ID: subjectID}, request.RuleID)
	if err != nil {
		writeError(w, http.StatusUnprocessableEntity, "recheck_failed", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, result)
}

func (s *server) proposeRepair(w http.ResponseWriter, r *http.Request) {
	var request RepairProposal
	if !decodeAction(w, r, &request) {
		return
	}
	plan, err := s.operator.ProposeRepair(r.Context(), request)
	if err != nil {
		writeError(w, http.StatusUnprocessableEntity, "repair_proposal_failed", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, plan)
}

func (s *server) repairAction(w http.ResponseWriter, r *http.Request) {
	rest := strings.TrimPrefix(strings.Trim(r.URL.Path, "/"), "api/v1/repairs/")
	id, verb, found := strings.Cut(rest, "/")
	if !found || strings.TrimSpace(id) == "" {
		writeError(w, http.StatusBadRequest, "invalid_repair", "repair id and action are required")
		return
	}
	id, err := url.PathUnescape(id)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid_repair", "repair id is invalid")
		return
	}
	var plan RepairPlan
	switch verb {
	case "preview":
		if !decodeOptionalAction(w, r) {
			return
		}
		plan, err = s.operator.PreviewRepair(r.Context(), id)
	case "approve":
		var request struct {
			Actor  string `json:"actor"`
			Reason string `json:"reason"`
		}
		if !decodeAction(w, r, &request) {
			return
		}
		plan, err = s.operator.ApproveRepair(r.Context(), id, request.Actor, request.Reason)
	case "execute":
		if !decodeOptionalAction(w, r) {
			return
		}
		plan, err = s.operator.ExecuteRepair(r.Context(), id)
	default:
		writeError(w, http.StatusNotFound, "not_found", "repair action not found")
		return
	}
	if err != nil {
		writeError(w, http.StatusUnprocessableEntity, "repair_action_failed", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, plan)
}

func decodeAction(w http.ResponseWriter, r *http.Request, target any) bool {
	r.Body = http.MaxBytesReader(w, r.Body, 64<<10)
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_json", "action body is invalid or exceeds 64 KiB")
		return false
	}
	return true
}
func decodeOptionalAction(w http.ResponseWriter, r *http.Request) bool {
	if r.ContentLength == 0 {
		return true
	}
	var body struct{}
	return decodeAction(w, r, &body)
}

func (s *server) jobDetail(w http.ResponseWriter, r *http.Request) {
	id, err := url.PathUnescape(strings.TrimPrefix(r.URL.Path, "/api/v1/jobs/"))
	if err != nil || strings.TrimSpace(id) == "" || strings.Contains(id, "/") {
		writeError(w, http.StatusBadRequest, "invalid_job_id", "A single job id is required")
		return
	}
	detail, err := s.reader.JobDetail(r.Context(), id)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			writeError(w, http.StatusNotFound, "job_not_found", "Job not found")
			return
		}
		writeError(w, http.StatusInternalServerError, "job_detail_failed", err.Error())
		return
	}
	normalizeDetail(&detail)
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusOK, detail)
}

var ErrNotFound = errors.New("workbench record not found")

func parseQuery(values url.Values) (Query, error) {
	query := Query{
		Queue: strings.TrimSpace(values.Get("queue")),
		Limit: DefaultLimit,
	}
	if len(query.Queue) > 160 {
		return Query{}, errors.New("queue filter is too long")
	}
	if raw := values.Get("limit"); raw != "" {
		limit, err := strconv.Atoi(raw)
		if err != nil || limit < 1 || limit > MaxLimit {
			return Query{}, errors.New("limit must be between 1 and 250")
		}
		query.Limit = limit
	}
	if raw := values.Get("states"); raw != "" {
		seen := make(map[string]bool)
		for _, state := range strings.Split(raw, ",") {
			state = strings.TrimSpace(state)
			if !validState(state) {
				return Query{}, errors.New("states contains an unsupported job state")
			}
			if !seen[state] {
				query.States = append(query.States, state)
				seen[state] = true
			}
		}
	}
	return query, nil
}

func validState(state string) bool {
	switch state {
	case "pending", "leased", "succeeded", "retry_wait", "dead", "cancelled", "blocked":
		return true
	default:
		return false
	}
}

func sameOrigin(r *http.Request) bool {
	host := r.Host
	if parsedHost, _, err := net.SplitHostPort(host); err == nil {
		host = parsedHost
	}
	host = strings.Trim(host, "[]")
	if !strings.EqualFold(host, "localhost") {
		address := net.ParseIP(host)
		if address == nil || !address.IsLoopback() {
			return false
		}
	}
	origin := r.Header.Get("Origin")
	if origin == "" {
		return true
	}
	parsed, err := url.Parse(origin)
	if err != nil {
		return false
	}
	return parsed.Scheme == "http" && strings.EqualFold(parsed.Host, r.Host)
}

func securityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Security-Policy",
			"default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; "+
				"font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'")
		w.Header().Set("Cross-Origin-Opener-Policy", "same-origin")
		w.Header().Set("Referrer-Policy", "no-referrer")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("X-Frame-Options", "DENY")
		w.Header().Set("Permissions-Policy", "camera=(), microphone=(), geolocation=()")
		next.ServeHTTP(w, r)
	})
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

func writeError(w http.ResponseWriter, status int, code, message string) {
	writeJSON(w, status, map[string]any{
		"error": map[string]string{"code": code, "message": message},
	})
}

func normalizeSnapshot(snapshot *Snapshot) {
	if snapshot.Counts == nil {
		snapshot.Counts = map[string]int64{}
	}
	if snapshot.Jobs == nil {
		snapshot.Jobs = []Job{}
	}
	if snapshot.Attention == nil {
		snapshot.Attention = []AttentionItem{}
	}
	if snapshot.Findings == nil {
		snapshot.Findings = []Finding{}
	}
	if snapshot.Rules == nil {
		snapshot.Rules = []Rule{}
	}
	if snapshot.Queues == nil {
		snapshot.Queues = []string{}
	}
}

func normalizeDetail(detail *JobDetail) {
	if detail.Attempts == nil {
		detail.Attempts = []Attempt{}
	}
	if detail.Effects == nil {
		detail.Effects = []Effect{}
	}
	if detail.Outcomes == nil {
		detail.Outcomes = []Outcome{}
	}
	if detail.Audit == nil {
		detail.Audit = []Audit{}
	}
	if detail.Flight == nil {
		detail.Flight = buildFlight(detail)
	}
}

func buildFlight(detail *JobDetail) []FlightEvent {
	items := make([]FlightEvent, 0, 1+len(detail.Attempts)+len(detail.Effects)+len(detail.Outcomes)+len(detail.Audit))
	if !detail.Job.CreatedAt.IsZero() {
		items = append(items, FlightEvent{
			ID: "commit", Kind: "commit", Title: "Task committed",
			Detail: "Durable intent accepted", Status: "confirmed", OccurredAt: detail.Job.CreatedAt,
		})
	}
	for _, attempt := range detail.Attempts {
		detailText := strings.TrimSpace(strings.Join([]string{
			attempt.LeaseOwner,
			func() string {
				if attempt.FailureClass != "" {
					return "failure: " + attempt.FailureClass
				}
				return ""
			}(),
			func() string {
				if attempt.BlockedReason != "" {
					return "blocked: " + attempt.BlockedReason
				}
				return ""
			}(),
		}, " · "))
		items = append(items, FlightEvent{
			ID: fmt.Sprintf("attempt-%d", attempt.Sequence), Kind: "attempt",
			Title:  fmt.Sprintf("Attempt %d · %s", attempt.Attempt, humanFlight(attempt.Kind)),
			Detail: detailText, Status: attempt.ResultState, OccurredAt: attempt.OccurredAt,
			Attempt: attempt.Attempt, Reference: attempt.LeaseOwner,
		})
	}
	for _, effect := range detail.Effects {
		status := effect.State
		title := "Effect " + humanFlight(status)
		if status == "confirmed" {
			title = "Effect confirmed"
		}
		items = append(items, FlightEvent{
			ID: effect.ID, Kind: "effect", Title: title, Detail: effect.Name,
			Status: status, OccurredAt: effect.CreatedAt, Reference: effect.ExternalRef,
		})
	}
	for _, outcome := range detail.Outcomes {
		items = append(items, FlightEvent{
			ID: outcome.ID, Kind: "outcome", Title: "Outcome " + humanFlight(outcome.State),
			Detail: outcome.Reason, Status: outcome.State, OccurredAt: outcome.UpdatedAt,
			Reference: fmt.Sprintf("contract v%d", outcome.ContractVersion),
		})
	}
	for _, audit := range detail.Audit {
		items = append(items, FlightEvent{
			ID: audit.ID, Kind: "decision", Title: humanFlight(audit.Action), Detail: audit.Reason,
			Status: "recorded", OccurredAt: audit.OccurredAt, Actor: audit.Actor, Reference: audit.RowHash,
		})
	}
	sort.SliceStable(items, func(i, j int) bool { return items[i].OccurredAt.Before(items[j].OccurredAt) })
	return items
}

func humanFlight(value string) string {
	return strings.Title(strings.ReplaceAll(strings.ReplaceAll(value, "_", " "), "-", " "))
}

// subjectDetail serves the investigation view for one business subject.
//
// The path carries type and id separately because a subject id may contain
// almost anything an application uses as a primary key, and packing both into
// one segment would make "report/3912" ambiguous with a type called "report"
// and an id "3912".
func (s *server) subjectDetail(w http.ResponseWriter, r *http.Request) {
	rest := strings.TrimPrefix(r.URL.Path, "/api/v1/subjects/")
	subjectType, rawID, found := strings.Cut(rest, "/")
	if !found {
		writeError(w, http.StatusBadRequest, "invalid_subject",
			"A subject type and id are required: /api/v1/subjects/{type}/{id}")
		return
	}
	subjectType, typeErr := url.PathUnescape(subjectType)
	id, idErr := url.PathUnescape(rawID)
	if typeErr != nil || idErr != nil ||
		strings.TrimSpace(subjectType) == "" || strings.TrimSpace(id) == "" ||
		strings.Contains(id, "/") {
		writeError(w, http.StatusBadRequest, "invalid_subject",
			"A subject type and id are required: /api/v1/subjects/{type}/{id}")
		return
	}
	detail, err := s.reader.SubjectDetail(r.Context(), SubjectRef{
		Type: strings.TrimSpace(subjectType), ID: strings.TrimSpace(id),
	})
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			writeError(w, http.StatusNotFound, "subject_not_found",
				"RhinoQ has no findings or effects recorded for this subject")
			return
		}
		writeError(w, http.StatusInternalServerError, "subject_detail_failed", err.Error())
		return
	}
	normalizeSubject(&detail)
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusOK, detail)
}

// normalizeSubject fills the derived parts of the view so every Reader does not
// have to, and so the summary cannot disagree with the lists it summarises.
func normalizeSubject(detail *SubjectDetail) {
	if detail.Findings == nil {
		detail.Findings = []Finding{}
	}
	if detail.History == nil {
		detail.History = []SubjectEvent{}
	}
	if detail.Effects == nil {
		detail.Effects = []Effect{}
	}
	if detail.Executions == nil {
		detail.Executions = []ExecutionRef{}
	}
	sort.SliceStable(detail.History, func(i, j int) bool {
		return detail.History[i].OccurredAt.Before(detail.History[j].OccurredAt)
	})

	summary := SubjectSummary{Findings: len(detail.Findings)}
	for _, item := range detail.Findings {
		switch item.Status {
		case "open", "acknowledged", "repair_proposed", "repairing", "regressed":
			summary.OpenFindings++
		}
		if summary.FirstSeen.IsZero() || item.FirstSeen.Before(summary.FirstSeen) {
			summary.FirstSeen = item.FirstSeen
		}
		if item.LastSeen.After(summary.LastSeen) {
			summary.LastSeen = item.LastSeen
		}
	}
	for _, item := range detail.Effects {
		switch item.State {
		case "pending":
			summary.PendingEffects++
		case "uncertain":
			summary.UncertainEffects++
		}
	}

	// Uncertain outranks drift: an effect whose execution died has an unknown
	// result, and reporting that as clean or as plain drift would both be
	// claiming to know more than RhinoQ does.
	switch {
	case summary.UncertainEffects > 0:
		summary.State = "unknown"
		summary.Headline = "An effect was left in an unknown state by an execution that died."
	case summary.OpenFindings > 0:
		summary.State = "drift"
		summary.Headline = "This subject has drift nobody has resolved yet."
	case summary.Findings > 0:
		summary.State = "clean"
		summary.Headline = "Drift was recorded here before and is resolved now."
	default:
		summary.State = "clean"
		summary.Headline = "RhinoQ has recorded no drift for this subject."
	}
	detail.Summary = summary
}
