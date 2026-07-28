package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"os/signal"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/rhinoq/rhinoq/internal/interfaces/workbench"
	"github.com/rhinoq/rhinoq/pkg/rhinoq"
)

const workbenchVersion = "0.1.0-dev"

func runWorkbench(
	args []string,
	getenv func(string) string,
	output io.Writer,
) int {
	flags := flag.NewFlagSet("workbench", flag.ContinueOnError)
	flags.SetOutput(output)
	demo := flags.Bool("demo", false, "use a local sample dataset without PostgreSQL")
	port := flags.Int("port", 8787, "loopback port; use 0 to select an available port")
	queue := flags.String("queue", "", "optional initial queue filter")
	noOpen := flags.Bool("no-open", false, "print the URL without opening a browser")
	if err := flags.Parse(args); err != nil {
		return 2
	}
	if *port < 0 || *port > 65535 {
		fmt.Fprintln(output, "FAIL --port must be between 0 and 65535")
		return 2
	}
	if len(strings.TrimSpace(*queue)) > 160 {
		fmt.Fprintln(output, "FAIL --queue is too long")
		return 2
	}

	var (
		reader workbench.Reader
		closer io.Closer
	)
	if *demo {
		reader = workbench.NewDemoReader()
	} else {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		client, database, err := openClient(ctx, getenv)
		if err != nil {
			fmt.Fprintf(output, "FAIL open Workbench data source: %v\n", err)
			fmt.Fprintln(output, "Try the interface without PostgreSQL: rhinoq workbench --demo")
			return 1
		}
		closer = database
		reader = &liveWorkbenchReader{
			client: client,
			source: databaseSourceLabel(getenv("RHINOQ_DATABASE_URL")),
		}
	}
	if closer != nil {
		defer closer.Close()
	}

	handler, err := workbench.NewHandler(reader, workbench.Options{Version: workbenchVersion})
	if err != nil {
		fmt.Fprintf(output, "FAIL build Workbench: %v\n", err)
		return 1
	}
	listener, err := net.Listen("tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(*port)))
	if err != nil {
		fmt.Fprintf(output, "FAIL listen on loopback port %d: %v\n", *port, err)
		return 1
	}
	defer listener.Close()

	address := listener.Addr().(*net.TCPAddr)
	workbenchURL := fmt.Sprintf("http://127.0.0.1:%d", address.Port)
	browserURL := workbenchURL
	if initialQueue := strings.TrimSpace(*queue); initialQueue != "" {
		browserURL += "/?queue=" + url.QueryEscape(initialQueue)
	}
	server := &http.Server{
		Handler:           handler,
		ReadHeaderTimeout: 5 * time.Second,
		IdleTimeout:       60 * time.Second,
		MaxHeaderBytes:    32 << 10,
	}
	serverErrors := make(chan error, 1)
	go func() {
		serverErrors <- server.Serve(listener)
	}()

	mode := "PostgreSQL"
	if *demo {
		mode = "sample data"
	}
	fmt.Fprintln(output, "RhinoQ Workbench")
	fmt.Fprintf(output, "  URL      %s\n", browserURL)
	fmt.Fprintf(output, "  Source   %s\n", mode)
	fmt.Fprintln(output, "  Access   loopback only · read-only · payloads omitted")
	fmt.Fprintln(output, "  Stop     Ctrl+C")

	shouldOpen := !*noOpen && !truthy(getenv("RHINOQ_WORKBENCH_NO_OPEN"))
	if shouldOpen {
		if err := openDefaultBrowser(browserURL); err != nil {
			fmt.Fprintf(output, "WARN browser was not opened: %v\n", err)
		}
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	select {
	case <-ctx.Done():
	case err := <-serverErrors:
		if err != nil && !errors.Is(err, http.ErrServerClosed) {
			fmt.Fprintf(output, "FAIL Workbench server: %v\n", err)
			return 1
		}
		return 0
	}
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := server.Shutdown(shutdownCtx); err != nil {
		fmt.Fprintf(output, "FAIL stop Workbench cleanly: %v\n", err)
		return 1
	}
	return 0
}

type liveWorkbenchReader struct {
	client *rhinoq.Client
	source string
}

func (r *liveWorkbenchReader) Snapshot(
	ctx context.Context,
	query workbench.Query,
) (workbench.Snapshot, error) {
	queue := query.Queue
	jobs, err := r.client.ListJobs(ctx, rhinoq.JobQuery{
		Queue: queue, States: query.States, Limit: query.Limit,
	})
	if err != nil {
		return workbench.Snapshot{}, err
	}
	counts, err := r.client.JobCounts(ctx, queue)
	if err != nil {
		return workbench.Snapshot{}, err
	}
	attention, err := r.client.ListAttention(ctx, queue, 0, 50)
	if err != nil {
		return workbench.Snapshot{}, err
	}
	findings, err := r.client.ListFindings(ctx, rhinoq.FindingQuery{
		Statuses: []string{
			rhinoq.FindingOpen, rhinoq.FindingAcknowledged,
			rhinoq.FindingRepairProposed, rhinoq.FindingRepairing,
			rhinoq.FindingRegressed,
		},
		Limit: 100,
	})
	if err != nil {
		return workbench.Snapshot{}, err
	}
	rules, err := r.client.ListRules(ctx, rhinoq.RuleQuery{Limit: 100})
	if err != nil {
		return workbench.Snapshot{}, err
	}

	queueProbe := jobs
	if queue != "" {
		queueProbe, err = r.client.ListJobs(ctx, rhinoq.JobQuery{Limit: workbench.MaxLimit})
		if err != nil {
			return workbench.Snapshot{}, err
		}
	}
	return workbench.Snapshot{
		Product: "RhinoQ Workbench", Version: workbenchVersion,
		GeneratedAt: time.Now().UTC(),
		Source: workbench.Source{
			Mode: "live", Label: r.source, ReadOnly: true,
		},
		Counts: counts, Jobs: publicJobs(jobs),
		Attention: publicAttention(attention),
		Findings:  publicFindings(findings),
		Rules:     publicRules(rules), Queues: queueNames(queueProbe),
		Limits: map[string]int{
			"jobs": query.Limit, "attention": 50, "findings": 100,
			"rules": 100, "evidence": 100,
		},
		Notices: []string{
			"Workbench reads RhinoQ through the public application facade.",
			"Job payloads are intentionally excluded from this interface.",
		},
	}, nil
}

func (r *liveWorkbenchReader) JobDetail(
	ctx context.Context,
	id string,
) (workbench.JobDetail, error) {
	job, err := r.client.GetJob(ctx, id)
	if errors.Is(err, rhinoq.ErrJobNotFound) {
		return workbench.JobDetail{}, workbench.ErrNotFound
	}
	if err != nil {
		return workbench.JobDetail{}, err
	}
	attempts, err := r.client.AttemptTimeline(ctx, id, 0, 100)
	if err != nil {
		return workbench.JobDetail{}, err
	}
	effects, err := r.client.ListEffectEvidence(ctx, id, 0, 100)
	if err != nil {
		return workbench.JobDetail{}, err
	}
	outcomes, err := r.client.ListOutcomeEvidence(ctx, id, 0, 100)
	if err != nil {
		return workbench.JobDetail{}, err
	}
	audit, err := r.client.AuditTrail(ctx, id, 0, 100)
	if err != nil {
		return workbench.JobDetail{}, err
	}
	return workbench.JobDetail{
		Job: publicJob(job), Attempts: publicAttempts(attempts),
		Effects: publicEffects(effects), Outcomes: publicOutcomes(outcomes),
		Audit: publicAudit(audit),
		Notices: []string{
			"Payload is hidden by design. Follow the correlation id to the owning application record.",
		},
	}, nil
}

func publicJobs(records []rhinoq.JobSummary) []workbench.Job {
	result := make([]workbench.Job, 0, len(records))
	for _, record := range records {
		result = append(result, publicJob(record))
	}
	return result
}

func publicJob(record rhinoq.JobSummary) workbench.Job {
	return workbench.Job{
		ID: record.ID, Name: record.Name, State: record.State,
		Class: record.Class, Stage: jobStage(record.State),
		Priority: record.Priority, Attempts: record.Attempts,
		CrashCount: record.CrashCount, BlockedReason: record.BlockedReason,
		CorrelationID: record.CorrelationID, CreatedAt: record.CreatedAt,
		NotBefore: record.NotBefore, CancelRequested: record.CancelRequested,
	}
}

func publicAttention(records []rhinoq.AttentionItem) []workbench.AttentionItem {
	result := make([]workbench.AttentionItem, 0, len(records))
	for _, record := range records {
		result = append(result, workbench.AttentionItem{
			Kind: record.Kind, JobID: record.JobID, Queue: record.Queue,
			JobState: record.JobState, ReferenceID: record.ReferenceID,
			Reason: record.Reason, ObservedAt: record.ObservedAt,
		})
	}
	return result
}

func publicFindings(records []rhinoq.FindingRecord) []workbench.Finding {
	result := make([]workbench.Finding, 0, len(records))
	for _, record := range records {
		result = append(result, workbench.Finding{
			RuleID: record.RuleID, SubjectType: record.SubjectType,
			SubjectID: record.SubjectID, InvariantVersion: record.InvariantVersion,
			Status: record.Status, FirstSeen: record.FirstSeen,
			LastSeen: record.LastSeen, OccurrenceCount: record.OccurrenceCount,
			LatestEvidence: record.LatestEvidence,
		})
	}
	return result
}

func publicRules(records []rhinoq.RuleRecord) []workbench.Rule {
	result := make([]workbench.Rule, 0, len(records))
	for _, record := range records {
		result = append(result, workbench.Rule{
			ID: record.ID, Name: record.Name, Scope: record.Scope,
			SubjectType: record.SubjectType, JobName: record.JobName,
			Version: record.Version, Status: record.Status, Every: record.Every,
			UpdatedAt: record.UpdatedAt,
		})
	}
	return result
}

func publicAttempts(records []rhinoq.AttemptEvent) []workbench.Attempt {
	result := make([]workbench.Attempt, 0, len(records))
	for _, record := range records {
		result = append(result, workbench.Attempt{
			Sequence: record.Sequence, Attempt: record.Attempt,
			LeaseOwner: record.LeaseOwner, LeaseEpoch: record.LeaseEpoch,
			Kind: record.Kind, ResultState: record.ResultState,
			FailureClass: record.FailureClass, BlockedReason: record.BlockedReason,
			OccurredAt: record.OccurredAt,
		})
	}
	return result
}

func publicEffects(records []rhinoq.EffectEvidence) []workbench.Effect {
	result := make([]workbench.Effect, 0, len(records))
	for _, record := range records {
		result = append(result, workbench.Effect{
			ID: record.ID, Name: record.Name,
			IdempotencyKey: record.IdempotencyKey, State: record.State,
			Irreversible: record.Irreversible, ExternalRef: record.ExternalRef,
			CreatedAt: record.CreatedAt, LeaseEpoch: record.LeaseEpoch,
		})
	}
	return result
}

func publicOutcomes(records []rhinoq.OutcomeEvidence) []workbench.Outcome {
	result := make([]workbench.Outcome, 0, len(records))
	for _, record := range records {
		result = append(result, workbench.Outcome{
			ID: record.ID, ContractVersion: record.ContractVersion,
			State: record.State, Reason: record.Reason,
			ObservedVersion: record.ObservedVersion, UpdatedAt: record.UpdatedAt,
		})
	}
	return result
}

func publicAudit(records []rhinoq.AuditRecord) []workbench.Audit {
	result := make([]workbench.Audit, 0, len(records))
	for _, record := range records {
		result = append(result, workbench.Audit{
			ID: record.ID, Action: record.Action, Actor: record.Actor,
			Reason: record.Reason, OccurredAt: record.OccurredAt,
			RowHash: record.RowHash,
		})
	}
	return result
}

func queueNames(jobs []rhinoq.JobSummary) []string {
	seen := make(map[string]bool)
	for _, item := range jobs {
		seen[item.Name] = true
	}
	result := make([]string, 0, len(seen))
	for name := range seen {
		result = append(result, name)
	}
	sort.Strings(result)
	return result
}

func jobStage(state string) string {
	switch state {
	case "succeeded":
		return "verify"
	case "dead", "blocked", "cancelled":
		return "recover"
	default:
		return "run"
	}
}

func databaseSourceLabel(raw string) string {
	parsed, err := url.Parse(raw)
	if err != nil || parsed.Hostname() == "" {
		return "Application PostgreSQL"
	}
	database := strings.TrimPrefix(parsed.EscapedPath(), "/")
	if database == "" {
		database = "postgres"
	}
	return parsed.Hostname() + "/" + database
}

func openDefaultBrowser(target string) error {
	var command *exec.Cmd
	switch runtime.GOOS {
	case "windows":
		command = exec.Command("rundll32", "url.dll,FileProtocolHandler", target)
	case "darwin":
		command = exec.Command("open", target)
	default:
		command = exec.Command("xdg-open", target)
	}
	return command.Start()
}

func truthy(value string) bool {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "1", "true", "yes", "on":
		return true
	default:
		return false
	}
}
