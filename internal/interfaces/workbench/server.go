package workbench

import (
	"embed"
	"encoding/json"
	"errors"
	"io/fs"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

//go:embed static/*
var assets embed.FS

type Options struct {
	Version string
}

type server struct {
	reader  Reader
	static  http.Handler
	version string
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
		reader:  reader,
		static:  http.FileServer(http.FS(public)),
		version: options.Version,
	}
	return securityHeaders(http.HandlerFunc(s.serveHTTP)), nil
}

func (s *server) serveHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		writeError(w, http.StatusMethodNotAllowed, "method_not_allowed", "Workbench v0 is read-only")
		return
	}
	if !sameOrigin(r) {
		writeError(w, http.StatusForbidden, "cross_origin_request", "Workbench only accepts same-origin browser requests")
		return
	}
	switch {
	case r.URL.Path == "/healthz":
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		w.Header().Set("Cache-Control", "no-store")
		writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
	case r.URL.Path == "/api/v1/snapshot":
		s.snapshot(w, r)
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
	if snapshot.Limits == nil {
		snapshot.Limits = map[string]int{"jobs": query.Limit}
	}
	normalizeSnapshot(&snapshot)
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusOK, snapshot)
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
}
