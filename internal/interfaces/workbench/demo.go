package workbench

import (
	"context"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

func int64Ptr(value int64) *int64 { return &value }

type demoReader struct {
	now     func() time.Time
	jobs    []Job
	details map[string]JobDetail
}

func NewDemoReader() Reader {
	now := time.Now().UTC().Truncate(time.Second)
	jobs := demoJobs(now)
	return &demoReader{
		now:     func() time.Time { return time.Now().UTC() },
		jobs:    jobs,
		details: demoDetails(now, jobs),
	}
}

// DemoRuleTester exercises the exact same read-only Rule Console contract as
// a live Application-backed tester. It is intentionally deterministic and
// bounded so the demo never evaluates arbitrary SQL or contacts a provider.
func (d *demoReader) TestRule(_ context.Context, ruleID, subjectID string) (RuleTestResult, error) {
	now := d.now()
	for _, rule := range demoRules(now) {
		if rule.ID != ruleID {
			continue
		}
		result := RuleTestResult{
			RuleID: rule.ID, SubjectID: subjectID, RuleVersion: rule.Version,
			Status: "pass", Reason: "No bounded evidence contradicts this Rule for the subject.",
			EvaluatedAt: now,
			Samples:     []string{"subject_id=" + subjectID, "rule_version=" + strconv.Itoa(rule.Version)},
		}
		for _, finding := range demoFindings(now) {
			if finding.RuleID == ruleID && finding.SubjectID == subjectID {
				result.Status = "finding"
				result.Reason = finding.LatestEvidence
				result.Samples = []string{finding.LatestEvidence}
				break
			}
		}
		return result, nil
	}
	return RuleTestResult{}, ErrNotFound
}

// NewDemoOperator exposes a safe, in-memory version of the guarded action
// contract so the full Workbench workflow can be inspected without a database
// or external provider. It never mutates demo jobs or calls the network.
func NewDemoOperator() Operator { return &demoOperator{plans: map[string]BulkPlan{}} }

type demoOperator struct {
	mu    sync.Mutex
	plans map[string]BulkPlan
}

func (o *demoOperator) Recheck(_ context.Context, subject SubjectRef, ruleID string) (ActionResult, error) {
	return ActionResult{Status: "drift", Detail: "Demo recheck evaluated " + ruleID + " for " + subject.Type + "/" + subject.ID}, nil
}
func (o *demoOperator) ProposeRepair(_ context.Context, request RepairProposal) (RepairPlan, error) {
	return RepairPlan{ID: "repair_demo_01", State: "proposed", Handler: request.Handler, ProposedBy: request.Actor, Version: 1}, nil
}
func (o *demoOperator) PreviewRepair(_ context.Context, id string) (RepairPlan, error) {
	return RepairPlan{ID: id, State: "previewed", Handler: "registered-demo-handler", Preview: "Would reconcile the bounded subject record", Precondition: "provider read-back is confirmed", DryRun: true, Version: 2}, nil
}
func (o *demoOperator) ApproveRepair(_ context.Context, id, actor, reason string) (RepairPlan, error) {
	return RepairPlan{ID: id, State: "approved", ApprovedBy: actor, ApprovalReason: reason, Version: 3}, nil
}
func (o *demoOperator) ExecuteRepair(_ context.Context, id string) (RepairPlan, error) {
	return RepairPlan{ID: id, State: "succeeded", Outcome: "Demo post-check passed; no external provider was called", Version: 4}, nil
}
func (o *demoOperator) PreviewBulk(_ context.Context, request BulkActionRequest) (BulkPlan, error) {
	o.mu.Lock()
	defer o.mu.Unlock()
	plan := BulkPlan{ID: "bulk_demo_01", Action: request.Action, State: "previewed", ProposedBy: request.Actor, Version: 1}
	for _, id := range request.JobIDs {
		plan.Total++
		if strings.Contains(id, "PROVISION") || strings.Contains(id, "EXPORT") {
			plan.Uncertain = append(plan.Uncertain, BulkClassification{JobID: id, Reason: "demo effect confirmation is incomplete"})
		} else {
			plan.Safe = append(plan.Safe, BulkClassification{JobID: id, Reason: "demo evidence has no unresolved effect"})
		}
	}
	o.plans[plan.ID] = plan
	return plan, nil
}
func (o *demoOperator) ApproveBulk(_ context.Context, id, actor, reason string) (BulkPlan, error) {
	o.mu.Lock()
	defer o.mu.Unlock()
	plan := o.plans[id]
	plan.State, plan.ApprovedBy, plan.Reason, plan.Version = "approved", actor, reason, plan.Version+1
	o.plans[id] = plan
	return plan, nil
}
func (o *demoOperator) ExecuteBulk(_ context.Context, id string) (BulkPlan, error) {
	o.mu.Lock()
	defer o.mu.Unlock()
	plan := o.plans[id]
	plan.State, plan.Outcome, plan.Version = "verified", "Demo post-check passed for every safe item; uncertain items stayed blocked", plan.Version+1
	o.plans[id] = plan
	return plan, nil
}

func (d *demoReader) Snapshot(_ context.Context, query Query) (Snapshot, error) {
	jobs := make([]Job, 0, len(d.jobs))
	stateFilter := make(map[string]bool, len(query.States))
	for _, state := range query.States {
		stateFilter[state] = true
	}
	for _, item := range d.jobs {
		if query.Queue != "" && item.QueueName != query.Queue {
			continue
		}
		if len(stateFilter) > 0 && !stateFilter[item.State] {
			continue
		}
		jobs = append(jobs, item)
		if len(jobs) == query.Limit {
			break
		}
	}
	counts := make(map[string]int64)
	queues := make(map[string]bool)
	for _, item := range d.jobs {
		if query.Queue == "" || item.QueueName == query.Queue {
			counts[item.State]++
		}
		queues[item.QueueName] = true
	}
	queueNames := make([]string, 0, len(queues))
	for name := range queues {
		queueNames = append(queueNames, name)
	}
	sort.Strings(queueNames)
	return Snapshot{
		Product: "RhinoQ Workbench", Version: "0.1.0-dev",
		GeneratedAt: d.now(),
		Source:      Source{Mode: "demo", Label: "Local sample dataset", ReadOnly: true},
		Counts:      counts, Jobs: jobs, Queues: queueNames,
		Attention: demoAttention(d.now()),
		Findings:  demoFindings(d.now()),
		Rules:     demoRules(d.now()),
		Limits:    map[string]int{"jobs": query.Limit, "attention": 50, "evidence": 100},
		Notices: []string{
			"Demo mode uses local sample data and never connects to PostgreSQL.",
			"Job payloads are intentionally excluded from every Workbench response.",
		},
	}, nil
}

func (d *demoReader) JobDetail(_ context.Context, id string) (JobDetail, error) {
	detail, ok := d.details[id]
	if !ok {
		return JobDetail{}, ErrNotFound
	}
	return detail, nil
}

// demoJobs deliberately shows the identity split at work: media-cpu carries two
// different contracts in one lane, and process-media appears under two group
// keys, so the browser view exercises lane, contract and partition separately.
func demoJobs(now time.Time) []Job {
	return []Job{
		{
			ID: "job_01J0REPORT7D9A", QueueName: "reports", JobName: "generate-report",
			GroupKey: "tenant-acme", State: "succeeded",
			ResourceClass: "interactive", Stage: "verify", Priority: 20, Attempts: 1,
			CorrelationID: "report_8W4Q", CreatedAt: now.Add(-9 * time.Minute),
			NotBefore: now.Add(-9 * time.Minute),
		},
		{
			ID: "job_01J0MEDIA8QK2", QueueName: "media-cpu", JobName: "process-media",
			GroupKey: "tenant-acme", State: "leased",
			ResourceClass: "standard", Stage: "run", Priority: 8, Attempts: 2,
			CorrelationID: "asset_41H9", CreatedAt: now.Add(-7 * time.Minute),
			NotBefore: now.Add(-6 * time.Minute),
			Progress:  Progress{Completed: 43, Total: int64Ptr(100), Message: "Processing media item 43", UpdatedAt: now.Add(-12 * time.Second), HasData: true},
		},
		{
			ID: "job_01J0SYNC9M4CV", QueueName: "catalog", JobName: "sync-catalog",
			State:         "retry_wait",
			ResourceClass: "batch", Stage: "run", Priority: -5, Attempts: 2,
			CorrelationID: "sync_20260728_02", CreatedAt: now.Add(-22 * time.Minute),
			NotBefore: now.Add(38 * time.Second),
		},
		{
			ID: "job_01J0PROVISION3P", QueueName: "accounts", JobName: "provision-account",
			GroupKey: "tenant-globex", State: "blocked",
			ResourceClass: "critical", Stage: "recover", Priority: 65, Attempts: 3,
			CrashCount: 1, BlockedReason: "unclassified_error",
			CorrelationID: "account_72KD", CreatedAt: now.Add(-34 * time.Minute),
			NotBefore: now.Add(-31 * time.Minute),
		},
		{
			ID: "job_01J0THUMB5TS7", QueueName: "media-cpu", JobName: "generate-thumbnail",
			GroupKey: "tenant-globex", State: "pending",
			ResourceClass: "standard", Stage: "run", Priority: 5,
			CorrelationID: "asset_8D2A", CreatedAt: now.Add(-74 * time.Second),
			NotBefore: now.Add(4 * time.Minute),
			Progress:  Progress{Completed: 18, Total: int64Ptr(60), Message: "Preparing thumbnail batch", UpdatedAt: now.Add(-8 * time.Second), HasData: true},
		},
		{
			ID: "job_01J0EXPORT6AZ", QueueName: "reports", JobName: "export-dataset",
			State:         "dead",
			ResourceClass: "batch", Stage: "recover", Priority: -12, Attempts: 4,
			CorrelationID: "export_K19F", CreatedAt: now.Add(-2 * time.Hour),
			NotBefore: now.Add(-94 * time.Minute),
			Progress:  Progress{Completed: 72, Total: int64Ptr(100), Message: "Export stopped after provider confirmation gap", UpdatedAt: now.Add(-89 * time.Minute), HasData: true},
		},
		{
			ID: "job_01J0EMAIL0FJQ", QueueName: "notifications", JobName: "send-notification",
			GroupKey: "tenant-globex", State: "succeeded",
			ResourceClass: "standard", Stage: "verify", Attempts: 1,
			CorrelationID: "account_72KD", CreatedAt: now.Add(-41 * time.Minute),
			NotBefore: now.Add(-41 * time.Minute),
		},
		{
			ID: "job_01J0INDEX2N18", QueueName: "catalog", JobName: "refresh-search-index",
			State:         "cancelled",
			ResourceClass: "maintenance", Stage: "recover", Priority: -20,
			CorrelationID: "index_products_v42", CreatedAt: now.Add(-3 * time.Hour),
			NotBefore: now.Add(-3 * time.Hour), CancelRequested: true,
		},
	}
}

func demoDetails(now time.Time, jobs []Job) map[string]JobDetail {
	details := make(map[string]JobDetail, len(jobs))
	for _, item := range jobs {
		details[item.ID] = JobDetail{
			Job: item,
			Attempts: []Attempt{{
				Sequence: 1, Attempt: max(1, item.Attempts), LeaseOwner: "worker-local-01",
				LeaseEpoch: int64(max(1, item.Attempts)), Kind: attemptKind(item.State),
				ResultState: item.State, OccurredAt: item.CreatedAt.Add(2 * time.Second),
			}},
			Notices: []string{"Payload is hidden by design. Use the correlation id to inspect the owning application record."},
		}
	}
	report := details["job_01J0REPORT7D9A"]
	report.Attempts = []Attempt{
		{Sequence: 11, Attempt: 1, LeaseOwner: "reports-01", LeaseEpoch: 1, Kind: "claimed", ResultState: "leased", OccurredAt: now.Add(-8*time.Minute - 55*time.Second)},
		{Sequence: 12, Attempt: 1, LeaseOwner: "reports-01", LeaseEpoch: 1, Kind: "succeeded", ResultState: "succeeded", OccurredAt: now.Add(-7*time.Minute - 42*time.Second)},
	}
	report.Effects = []Effect{{
		ID: "eff_01J0REPORTPDF", Name: "upload-report", IdempotencyKey: "report_8W4Q:pdf",
		State: "confirmed", ExternalRef: "reports/report_8W4Q.pdf",
		CreatedAt: now.Add(-8 * time.Minute), LeaseEpoch: 1,
	}}
	report.Outcomes = []Outcome{{
		ID: "out_01J0REPORTREADY", ContractVersion: 2, State: "achieved",
		Reason: "report status is READY and output object exists", ObservedVersion: 17,
		UpdatedAt: now.Add(-7 * time.Minute),
	}}
	details[report.Job.ID] = report

	media := details["job_01J0MEDIA8QK2"]
	media.Attempts = []Attempt{
		{Sequence: 21, Attempt: 1, LeaseOwner: "media-02", LeaseEpoch: 1, Kind: "lease_expired", ResultState: "pending", FailureClass: "worker_crash", OccurredAt: now.Add(-5 * time.Minute)},
		{Sequence: 22, Attempt: 2, LeaseOwner: "media-03", LeaseEpoch: 2, Kind: "claimed", ResultState: "leased", OccurredAt: now.Add(-62 * time.Second)},
	}
	media.Effects = []Effect{{
		ID: "eff_01J0MEDIA202", Name: "submit-transcode", IdempotencyKey: "asset_41H9:transcode",
		State: "pending", ExternalRef: "provider_run_5K3", CreatedAt: now.Add(-57 * time.Second),
		LeaseEpoch: 2,
	}}
	media.Outcomes = []Outcome{{
		ID: "out_01J0MEDIASET", ContractVersion: 1, State: "pending",
		Reason: "waiting for all declared renditions", UpdatedAt: now.Add(-56 * time.Second),
	}}
	details[media.Job.ID] = media

	blocked := details["job_01J0PROVISION3P"]
	blocked.Attempts = []Attempt{
		{Sequence: 31, Attempt: 1, LeaseOwner: "accounts-01", LeaseEpoch: 1, Kind: "retry_scheduled", ResultState: "retry_wait", FailureClass: "transient", OccurredAt: now.Add(-29 * time.Minute)},
		{Sequence: 32, Attempt: 2, LeaseOwner: "accounts-02", LeaseEpoch: 2, Kind: "blocked", ResultState: "blocked", FailureClass: "unknown", BlockedReason: "unclassified_error", OccurredAt: now.Add(-12 * time.Minute)},
	}
	blocked.Effects = []Effect{{
		ID: "eff_01J0PROVISION", Name: "create-provider-account",
		IdempotencyKey: "account_72KD:provider", State: "uncertain",
		ExternalRef: "request accepted; confirmation missing",
		CreatedAt:   now.Add(-28 * time.Minute), LeaseEpoch: 1,
	}}
	blocked.Audit = []Audit{{
		ID: "audit_01J0ACK", Action: "attention_acknowledged",
		Actor: "dev@local", Reason: "checking provider before replay",
		OccurredAt: now.Add(-4 * time.Minute),
		RowHash:    strings.Repeat("a7", 32),
	}}
	details[blocked.Job.ID] = blocked
	return details
}

func demoAttention(now time.Time) []AttentionItem {
	return []AttentionItem{
		{
			Kind: "effect_uncertain", JobID: "job_01J0PROVISION3P",
			Queue: "provision-account", JobState: "blocked",
			Reason:     "provider request was accepted but the confirmation signal is missing",
			ObservedAt: now.Add(-12 * time.Minute),
		},
		{
			Kind: "integrity_finding", ReferenceID: "ready-report-has-output/report/report_3Q1N/v2",
			Reason:     "business invariant regressed after it had been resolved",
			ObservedAt: now.Add(-18 * time.Minute),
		},
		{
			Kind: "dead_job", JobID: "job_01J0EXPORT6AZ", Queue: "export-dataset",
			JobState: "dead", Reason: "job exhausted its execution policy",
			ObservedAt: now.Add(-94 * time.Minute),
		},
	}
}

func demoFindings(now time.Time) []Finding {
	return []Finding{
		{
			RuleID: "ready-report-has-output", SubjectType: "report",
			SubjectID: "report_3Q1N", InvariantVersion: 2, Status: "regressed",
			FirstSeen: now.Add(-3 * time.Hour), LastSeen: now.Add(-18 * time.Minute),
			OccurrenceCount: 3, LatestEvidence: `{"status":"READY","outputKey":null}`,
		},
		{
			RuleID: "media-has-all-renditions", SubjectType: "asset",
			SubjectID: "asset_1A8K", InvariantVersion: 1, Status: "open",
			FirstSeen: now.Add(-46 * time.Minute), LastSeen: now.Add(-21 * time.Minute),
			OccurrenceCount: 2, LatestEvidence: `{"expected":4,"actual":3}`,
		},
	}
}

func demoRules(now time.Time) []Rule {
	return []Rule{
		{
			ID: "ready-report-has-output", Name: "Ready reports have an output object",
			Scope: "table", SubjectType: "report", Version: 2, Status: "enabled",
			Every: 10 * time.Minute, UpdatedAt: now.Add(-2 * time.Hour),
			Versions: []RuleVersion{{Version: 1, Status: "retired", UpdatedAt: now.Add(-9 * time.Hour), Note: "Initial contract"}, {Version: 2, Status: "enabled", UpdatedAt: now.Add(-2 * time.Hour), Note: "Requires READY plus output object"}},
		},
		{
			ID: "media-has-all-renditions", Name: "Media has every declared rendition",
			Scope: "table", SubjectType: "asset", Version: 1, Status: "enabled",
			Every: 5 * time.Minute, UpdatedAt: now.Add(-5 * time.Hour),
			Versions: []RuleVersion{{Version: 1, Status: "enabled", UpdatedAt: now.Add(-5 * time.Hour), Note: "All renditions must be present"}},
		},
		{
			ID: "provisioning-reaches-active", Name: "Provisioning reaches active state",
			Scope: "job", SubjectType: "account", JobName: "provision-account",
			Version: 3, Status: "draft", Every: 15 * time.Minute,
			UpdatedAt: now.Add(-38 * time.Minute),
			Versions:  []RuleVersion{{Version: 1, Status: "draft", UpdatedAt: now.Add(-38 * time.Minute), Note: "Draft for provisioning verification"}, {Version: 2, Status: "draft", UpdatedAt: now.Add(-20 * time.Minute), Note: "Adds ACTIVE transition"}, {Version: 3, Status: "draft", UpdatedAt: now.Add(-8 * time.Minute), Note: "Pending application review"}},
		},
	}
}

func attemptKind(state string) string {
	switch state {
	case "succeeded":
		return "succeeded"
	case "dead":
		return "dead"
	case "blocked":
		return "blocked"
	case "cancelled":
		return "cancelled"
	case "retry_wait":
		return "retry_scheduled"
	default:
		return "claimed"
	}
}

// SubjectDetail shows the investigation view the demo dataset can support. It
// deliberately includes an execution RhinoQ did not run, because that is the
// case the page exists to make legible.
func (d *demoReader) SubjectDetail(_ context.Context, subject SubjectRef) (SubjectDetail, error) {
	now := d.now()
	findings := make([]Finding, 0, 2)
	for _, item := range demoFindings(now) {
		if item.SubjectType == subject.Type && item.SubjectID == subject.ID {
			findings = append(findings, item)
		}
	}
	effects := demoSubjectEffects(now, subject)
	if len(findings) == 0 && len(effects) == 0 {
		return SubjectDetail{}, ErrNotFound
	}

	detail := SubjectDetail{
		Subject: subject, Findings: findings, Effects: effects,
		Executions: executionsFromEffects(effects),
		Notices: []string{
			"Demo mode uses local sample data and never connects to PostgreSQL.",
			"Payloads are excluded from every Workbench response by design.",
		},
	}
	for _, item := range findings {
		detail.History = append(detail.History, SubjectEvent{
			Kind: SubjectEventObservation, OccurredAt: item.FirstSeen,
			Label: "violation observed", RuleID: item.RuleID,
			InvariantVersion: item.InvariantVersion, ToStatus: "open",
			Evidence: item.LatestEvidence,
		})
		if item.Status == "regressed" {
			detail.History = append(detail.History, SubjectEvent{
				Kind: SubjectEventDecision, OccurredAt: item.FirstSeen.Add(time.Hour),
				Label: "resolved by operator", RuleID: item.RuleID,
				InvariantVersion: item.InvariantVersion,
				FromStatus:       "open", ToStatus: "resolved",
				Actor: "ops@example.com", Reason: "re-ran the export",
			})
			detail.History = append(detail.History, SubjectEvent{
				Kind: SubjectEventObservation, OccurredAt: item.LastSeen,
				Label: "regressed", RuleID: item.RuleID,
				InvariantVersion: item.InvariantVersion,
				FromStatus:       "resolved", ToStatus: "regressed",
				Evidence: item.LatestEvidence,
			})
		}
	}
	for _, item := range effects {
		detail.History = append(detail.History, SubjectEvent{
			Kind: SubjectEventEffect, OccurredAt: item.CreatedAt,
			Label:     item.Name + " " + item.State,
			Execution: item.SourceSystem + ":" + item.SourceID,
		})
	}
	return detail, nil
}

func demoSubjectEffects(now time.Time, subject SubjectRef) []Effect {
	if subject.Type != "report" || subject.ID != "report_3Q1N" {
		return nil
	}
	return []Effect{
		{
			ID: "eff_01J0DEMOEXPORT", Name: "export-report",
			SourceSystem: "bullmq", SourceID: "bull_8291",
			IdempotencyKey: "report_3Q1N:export", State: "confirmed",
			ExternalRef: "exports/report_3Q1N.csv", CreatedAt: now.Add(-3 * time.Hour),
		},
		{
			ID: "eff_01J0DEMOUPLOAD", Name: "upload-report",
			SourceSystem: "rhinoq", SourceID: "job_01J0REPORT7D9A",
			JobID:          "job_01J0REPORT7D9A",
			IdempotencyKey: "report_3Q1N:pdf", State: "pending",
			CreatedAt: now.Add(-19 * time.Minute), LeaseEpoch: 2,
		},
	}
}

// executionsFromEffects folds the ledger into the distinct runs that touched a
// subject, which is what an investigator actually asks for: not "which effects
// exist" but "who did something to this".
func executionsFromEffects(effects []Effect) []ExecutionRef {
	order := make([]string, 0, len(effects))
	byKey := make(map[string]*ExecutionRef, len(effects))
	for _, item := range effects {
		key := item.SourceSystem + "\x00" + item.SourceID
		existing, found := byKey[key]
		if !found {
			byKey[key] = &ExecutionRef{
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
	result := make([]ExecutionRef, 0, len(order))
	for _, key := range order {
		result = append(result, *byKey[key])
	}
	return result
}
