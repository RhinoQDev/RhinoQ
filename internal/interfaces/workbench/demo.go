package workbench

import (
	"context"
	"sort"
	"strings"
	"time"
)

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

func (d *demoReader) Snapshot(_ context.Context, query Query) (Snapshot, error) {
	jobs := make([]Job, 0, len(d.jobs))
	stateFilter := make(map[string]bool, len(query.States))
	for _, state := range query.States {
		stateFilter[state] = true
	}
	for _, item := range d.jobs {
		if query.Queue != "" && item.Name != query.Queue {
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
		if query.Queue == "" || item.Name == query.Queue {
			counts[item.State]++
		}
		queues[item.Name] = true
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

func demoJobs(now time.Time) []Job {
	return []Job{
		{
			ID: "job_01J0REPORT7D9A", Name: "generate-report", State: "succeeded",
			Class: "interactive", Stage: "verify", Priority: 20, Attempts: 1,
			CorrelationID: "report_8W4Q", CreatedAt: now.Add(-9 * time.Minute),
			NotBefore: now.Add(-9 * time.Minute),
		},
		{
			ID: "job_01J0MEDIA8QK2", Name: "process-media", State: "leased",
			Class: "standard", Stage: "run", Priority: 8, Attempts: 2,
			CorrelationID: "asset_41H9", CreatedAt: now.Add(-7 * time.Minute),
			NotBefore: now.Add(-6 * time.Minute),
		},
		{
			ID: "job_01J0SYNC9M4CV", Name: "sync-catalog", State: "retry_wait",
			Class: "batch", Stage: "run", Priority: -5, Attempts: 2,
			CorrelationID: "sync_20260728_02", CreatedAt: now.Add(-22 * time.Minute),
			NotBefore: now.Add(38 * time.Second),
		},
		{
			ID: "job_01J0PROVISION3P", Name: "provision-account", State: "blocked",
			Class: "critical", Stage: "recover", Priority: 65, Attempts: 3,
			CrashCount: 1, BlockedReason: "unclassified_error",
			CorrelationID: "account_72KD", CreatedAt: now.Add(-34 * time.Minute),
			NotBefore: now.Add(-31 * time.Minute),
		},
		{
			ID: "job_01J0THUMB5TS7", Name: "process-media", State: "pending",
			Class: "standard", Stage: "run", Priority: 5,
			CorrelationID: "asset_8D2A", CreatedAt: now.Add(-74 * time.Second),
			NotBefore: now.Add(4 * time.Minute),
		},
		{
			ID: "job_01J0EXPORT6AZ", Name: "export-dataset", State: "dead",
			Class: "batch", Stage: "recover", Priority: -12, Attempts: 4,
			CorrelationID: "export_K19F", CreatedAt: now.Add(-2 * time.Hour),
			NotBefore: now.Add(-94 * time.Minute),
		},
		{
			ID: "job_01J0EMAIL0FJQ", Name: "send-notification", State: "succeeded",
			Class: "standard", Stage: "verify", Attempts: 1,
			CorrelationID: "account_72KD", CreatedAt: now.Add(-41 * time.Minute),
			NotBefore: now.Add(-41 * time.Minute),
		},
		{
			ID: "job_01J0INDEX2N18", Name: "refresh-search-index", State: "cancelled",
			Class: "maintenance", Stage: "recover", Priority: -20,
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
		},
		{
			ID: "media-has-all-renditions", Name: "Media has every declared rendition",
			Scope: "table", SubjectType: "asset", Version: 1, Status: "enabled",
			Every: 5 * time.Minute, UpdatedAt: now.Add(-5 * time.Hour),
		},
		{
			ID: "provisioning-reaches-active", Name: "Provisioning reaches active state",
			Scope: "job", SubjectType: "account", JobName: "provision-account",
			Version: 3, Status: "draft", Every: 15 * time.Minute,
			UpdatedAt: now.Add(-38 * time.Minute),
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
