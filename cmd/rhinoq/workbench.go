package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
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

	"github.com/madebyduy/RhinoQ/internal/interfaces/workbench"
	"github.com/madebyduy/RhinoQ/pkg/rhinoq"
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
	actions := flags.Bool("actions", false, "enable recheck and registered safe-repair callbacks")
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
		reader   workbench.Reader
		operator workbench.Operator
		closer   io.Closer
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
		if *actions {
			repairs, registryErr := workbenchRepairRegistry(getenv("RHINOQ_REPAIR_CALLBACKS_JSON"))
			if registryErr != nil {
				fmt.Fprintf(output, "FAIL configure repair callbacks: %v\n", registryErr)
				return 1
			}
			operator = &liveWorkbenchOperator{client: client, repairs: repairs}
		}
	}
	if closer != nil {
		defer closer.Close()
	}

	handler, err := workbench.NewHandler(reader, workbench.Options{Version: workbenchVersion, Operator: operator})
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
	access := "loopback only · read-only · payloads omitted"
	if operator != nil {
		access = "loopback only · recheck/safe callbacks enabled · arbitrary SQL forbidden"
	}
	fmt.Fprintln(output, "  Access   "+access)
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

func workbenchRepairRegistry(raw string) (*rhinoq.RepairRegistry, error) {
	registry := rhinoq.NewRepairRegistry()
	if strings.TrimSpace(raw) == "" {
		return registry, nil
	}
	var callbacks map[string]struct {
		URL               string `json:"url"`
		Secret            string `json:"secret"`
		Timeout           string `json:"timeout"`
		AllowInsecureHTTP bool   `json:"allowInsecureHTTP"`
	}
	if err := json.Unmarshal([]byte(raw), &callbacks); err != nil {
		return nil, errors.New("RHINOQ_REPAIR_CALLBACKS_JSON must be an object keyed by repair handler name")
	}
	for name, config := range callbacks {
		timeout := 10 * time.Second
		if config.Timeout != "" {
			parsed, err := time.ParseDuration(config.Timeout)
			if err != nil || parsed <= 0 {
				return nil, fmt.Errorf("repair callback %q has an invalid timeout", name)
			}
			timeout = parsed
		}
		handler, err := rhinoq.NewHTTPRepairHandler(rhinoq.HTTPRepairHandlerOptions{
			URL: config.URL, Secret: config.Secret, Timeout: timeout,
			AllowInsecureHTTP: config.AllowInsecureHTTP,
		})
		if err != nil {
			return nil, fmt.Errorf("repair callback %q: %w", name, err)
		}
		if err := registry.Register(name, handler); err != nil {
			return nil, err
		}
	}
	return registry, nil
}

type liveWorkbenchOperator struct {
	client  *rhinoq.Client
	repairs *rhinoq.RepairRegistry
}

func (o *liveWorkbenchOperator) SetRecurringScheduleEnabled(ctx context.Context, tenantID, id string, version int64, enabled bool) (workbench.RecurringSchedule, error) {
	var record rhinoq.RecurringTaskSchedule
	var err error
	if enabled {
		record, err = o.client.ResumeRecurringTask(ctx, tenantID, id, version)
	} else {
		record, err = o.client.PauseRecurringTask(ctx, tenantID, id, version)
	}
	return publicRecurringSchedule(record), err
}

func (o *liveWorkbenchOperator) Recheck(ctx context.Context, subject workbench.SubjectRef, ruleID string) (workbench.ActionResult, error) {
	evaluation, err := o.client.EvaluateRule(ctx, ruleID, subject.ID, "")
	if err != nil {
		return workbench.ActionResult{}, err
	}
	result := workbench.ActionResult{Status: "clean", Detail: "Rule passed for this subject."}
	for _, observation := range evaluation.Observations {
		if observation.SubjectID == subject.ID && observation.Status != "pass" {
			result.Status, result.Detail = "drift", observation.Reason
			break
		}
	}
	return result, nil
}

func (o *liveWorkbenchOperator) ProposeRepair(ctx context.Context, request workbench.RepairProposal) (workbench.RepairPlan, error) {
	id, err := newWorkbenchRepairID()
	if err != nil {
		return workbench.RepairPlan{}, err
	}
	record, err := o.client.ProposeRepair(ctx, rhinoq.RepairProposal{
		ID: id,
		Finding: rhinoq.FindingKey{
			RuleID: request.Finding.RuleID, SubjectType: request.Finding.SubjectType,
			SubjectID: request.Finding.SubjectID, InvariantVersion: request.Finding.InvariantVersion,
		},
		Handler: request.Handler, Parameters: request.Parameters, Actor: request.Actor,
	})
	return workbenchRepair(record), err
}

func (o *liveWorkbenchOperator) PreviewRepair(ctx context.Context, id string) (workbench.RepairPlan, error) {
	record, err := o.client.PreviewRepair(ctx, id, o.repairs)
	return workbenchRepair(record), err
}
func (o *liveWorkbenchOperator) ApproveRepair(ctx context.Context, id, actor, reason string) (workbench.RepairPlan, error) {
	record, err := o.client.ApproveRepair(ctx, id, actor, reason)
	return workbenchRepair(record), err
}
func (o *liveWorkbenchOperator) ExecuteRepair(ctx context.Context, id string) (workbench.RepairPlan, error) {
	record, err := o.client.ExecuteRepair(ctx, id, o.repairs)
	return workbenchRepair(record), err
}

func newWorkbenchRepairID() (string, error) {
	var body [12]byte
	if _, err := rand.Read(body[:]); err != nil {
		return "", err
	}
	return "repair_" + hex.EncodeToString(body[:]), nil
}

func workbenchRepair(record rhinoq.RepairRecord) workbench.RepairPlan {
	return workbench.RepairPlan{
		ID: record.ID, State: record.State, Handler: record.Handler,
		Preview: record.Preview, Precondition: record.Precondition,
		ProposedBy: record.ProposedBy, ApprovedBy: record.ApprovedBy,
		ApprovalReason: record.ApprovalReason, Outcome: record.Outcome,
		DryRun: record.State == "previewed", Version: record.Version,
	}
}

type liveWorkbenchReader struct {
	client *rhinoq.Client
	source string
}

func (r *liveWorkbenchReader) ListRecurringSchedules(ctx context.Context, tenantID string, limit int) ([]workbench.RecurringSchedule, error) {
	records, err := r.client.ListRecurringTasks(ctx, tenantID, limit)
	if err != nil {
		return nil, err
	}
	result := make([]workbench.RecurringSchedule, len(records))
	for i, item := range records {
		result[i] = publicRecurringSchedule(item)
	}
	return result, nil
}
func publicRecurringSchedule(item rhinoq.RecurringTaskSchedule) workbench.RecurringSchedule {
	return workbench.RecurringSchedule{ID: item.ID, TaskName: item.TaskName, OwnerID: item.OwnerID, TenantID: item.TenantID, Every: item.Every, Cron: item.Cron, Timezone: item.Timezone, Enabled: item.Enabled, NextRunAt: item.NextRunAt, Version: item.Version}
}

func (r *liveWorkbenchReader) Snapshot(
	ctx context.Context,
	query workbench.Query,
) (workbench.Snapshot, error) {
	queue := query.Queue
	jobs, err := r.client.ListJobs(ctx, rhinoq.JobQuery{
		QueueName: queue, States: query.States, Limit: query.Limit,
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
		ID: record.ID, QueueName: record.QueueName, JobName: record.JobName,
		GroupKey: record.GroupKey, State: record.State,
		ResourceClass: record.ResourceClass, Stage: jobStage(record.State),
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
		seen[item.QueueName] = true
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

// SubjectDetail assembles the investigation view for one business subject.
//
// It reads from the integrity plane rather than from jobs, because the subject
// may never have had a RhinoQ job: the whole point is to answer "what happened
// to report_3912" for a team whose worker RhinoQ never ran.
func (r *liveWorkbenchReader) SubjectDetail(
	ctx context.Context,
	subject workbench.SubjectRef,
) (workbench.SubjectDetail, error) {
	findings, err := r.client.ListFindings(ctx, rhinoq.FindingQuery{
		SubjectType: subject.Type, SubjectID: subject.ID,
		IncludeSuppressed: true, Limit: 100,
	})
	if err != nil {
		return workbench.SubjectDetail{}, err
	}
	// An integrity-only deployment — a Rule and a connection string, no queue and
	// no worker — has no Effect Ledger at all. Treating that as fatal hid the
	// Findings, their evidence and their whole decision history behind a failure
	// for exactly the adoption path this product leads with. A missing ledger is
	// a gap in the page, not a reason to refuse to draw it.
	var effectsUnavailable string
	effects, err := r.client.SubjectEffects(ctx, rhinoq.SubjectRef{
		Type: subject.Type, ID: subject.ID,
	}, 0, 200)
	if err != nil {
		effects, effectsUnavailable = nil, err.Error()
	}
	if len(findings) == 0 && len(effects) == 0 && effectsUnavailable == "" {
		return workbench.SubjectDetail{}, workbench.ErrNotFound
	}
	if len(findings) == 0 && effectsUnavailable != "" {
		return workbench.SubjectDetail{}, workbench.ErrNotFound
	}

	detail := workbench.SubjectDetail{Subject: subject}
	for _, item := range findings {
		detail.Findings = append(detail.Findings, workbench.Finding{
			RuleID: item.RuleID, SubjectType: item.SubjectType,
			SubjectID: item.SubjectID, InvariantVersion: item.InvariantVersion,
			Status: item.Status, FirstSeen: item.FirstSeen, LastSeen: item.LastSeen,
			OccurrenceCount: item.OccurrenceCount, LatestEvidence: item.LatestEvidence,
		})
		history, err := r.client.FindingHistory(ctx, item.FindingKey, 0, 200)
		if err != nil {
			return workbench.SubjectDetail{}, err
		}
		for _, event := range history {
			detail.History = append(detail.History, subjectEventFromFinding(event))
		}
	}
	for _, item := range effects {
		detail.Effects = append(detail.Effects, workbench.Effect{
			ID: item.ID, Name: item.Name,
			SourceSystem: item.SourceSystem, SourceID: item.SourceID,
			JobID: item.JobID, IdempotencyKey: item.IdempotencyKey,
			State: item.State, Irreversible: item.Irreversible,
			ExternalRef: item.ExternalRef, CreatedAt: item.CreatedAt,
			LeaseEpoch: item.LeaseEpoch,
		})
		detail.History = append(detail.History, workbench.SubjectEvent{
			Kind: workbench.SubjectEventEffect, OccurredAt: item.CreatedAt,
			Label:     item.Name + " " + item.State,
			Execution: item.SourceSystem + ":" + item.SourceID,
		})
	}
	detail.Executions = executionsFromWorkbenchEffects(detail.Effects)
	detail.Notices = []string{
		"Payloads are excluded from every Workbench response by design.",
		"Business repair is not implemented: this page reports what happened, it cannot fix it.",
	}
	if effectsUnavailable != "" {
		detail.Notices = append(detail.Notices,
			"No Effect Ledger is available for this deployment, so the execution "+
				"timeline below is empty: "+effectsUnavailable)
	}
	return detail, nil
}

// subjectEventFromFinding classifies one finding event as something RhinoQ
// observed or something a person decided. An investigator needs that
// distinction more than any other on this page.
func subjectEventFromFinding(event rhinoq.FindingEvent) workbench.SubjectEvent {
	kind := workbench.SubjectEventDecision
	if event.Actor == "" {
		kind = workbench.SubjectEventObservation
	}
	label := event.Kind
	if label == "" {
		label = event.ToStatus
	}
	return workbench.SubjectEvent{
		Kind: kind, OccurredAt: event.OccurredAt, Label: label,
		RuleID: event.RuleID, InvariantVersion: event.InvariantVersion,
		FromStatus: event.FromStatus, ToStatus: event.ToStatus,
		Actor: event.Actor, Reason: event.Reason, Evidence: event.Evidence,
	}
}

func executionsFromWorkbenchEffects(effects []workbench.Effect) []workbench.ExecutionRef {
	order := make([]string, 0, len(effects))
	byKey := make(map[string]*workbench.ExecutionRef, len(effects))
	for _, item := range effects {
		key := item.SourceSystem + "\x00" + item.SourceID
		existing, found := byKey[key]
		if !found {
			byKey[key] = &workbench.ExecutionRef{
				SourceSystem: item.SourceSystem, SourceID: item.SourceID,
				JobID:     item.JobID,
				FirstSeen: item.CreatedAt, LastSeen: item.CreatedAt, Effects: 1,
			}
			order = append(order, key)
			continue
		}
		existing.Effects++
		if item.CreatedAt.Before(existing.FirstSeen) {
			existing.FirstSeen = item.CreatedAt
		}
		if item.CreatedAt.After(existing.LastSeen) {
			existing.LastSeen = item.CreatedAt
		}
	}
	result := make([]workbench.ExecutionRef, 0, len(order))
	for _, key := range order {
		result = append(result, *byKey[key])
	}
	return result
}
