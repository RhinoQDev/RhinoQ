package rhinoq

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"errors"
	"time"

	"github.com/madebyduy/RhinoQ/internal/adapters/memory"
	"github.com/madebyduy/RhinoQ/internal/adapters/postgres"
	"github.com/madebyduy/RhinoQ/internal/domain/correlation"
	"github.com/madebyduy/RhinoQ/internal/domain/effect"
	"github.com/madebyduy/RhinoQ/internal/domain/rule"
	"github.com/madebyduy/RhinoQ/internal/ports"
	"github.com/madebyduy/RhinoQ/internal/runtime/rulescheduler"
)

// IntegrityClient verifies declared business invariants and nothing else.
//
// It exists because the two questions RhinoQ answers have different audiences.
// A team that wants to know whether its report rows really have output files
// should not have to adopt a queue to find out, and *Client - which carries
// enqueue, workers, leases, effects and recovery - makes it look as though they
// do.
//
// This facade never starts a worker, claim loop, heartbeat, retry scheduler,
// lease reaper or recovery executor. Its only long-running operation is
// RunScheduler, which evaluates Rules on their declared cadence. Underneath it
// uses the same RuleStore, RuleEvaluator and FindingStore as *Client, so a
// deployment can adopt the runtime later without re-registering anything.
type IntegrityClient struct {
	findings      ports.FindingStore
	rules         ports.RuleStore
	ruleExplainer ports.RuleExplainer
	ruleEvaluator ports.RuleEvaluator
	ruleSchedules ports.RuleScheduleStore
	// externalEffects records and reads Effect Ledger entries for executions
	// RhinoQ did not run. It is nil for the in-memory facade, which has no
	// ledger.
	externalEffects ports.ExternalEffectStore
}

// NewIntegrity opens the integrity plane against an existing PostgreSQL
// database. The caller keeps ownership of the pool, and RhinoQ issues no
// statement against it until a method is called.
//
// Give this connection a read-only role for the business tables a Rule reads.
// The Explain gate bounds a Rule's shape, cost and timeout; it is not a SQL
// sandbox, and the queries it runs are written by developers.
func NewIntegrity(db *sql.DB) (*IntegrityClient, error) {
	if db == nil {
		return nil, errors.New("rhinoq requires a PostgreSQL database handle")
	}
	findingStore, err := postgres.NewFindingStore(db)
	if err != nil {
		return nil, err
	}
	ruleStore, err := postgres.NewRuleStore(db)
	if err != nil {
		return nil, err
	}
	ruleExplainer, err := postgres.NewRuleExplainer(db, nil)
	if err != nil {
		return nil, err
	}
	effectStore, err := postgres.NewEffectStore(db)
	if err != nil {
		return nil, err
	}
	ruleEvaluator, err := postgres.NewRuleEvaluator(db, nil)
	if err != nil {
		return nil, err
	}
	return &IntegrityClient{
		findings: findingStore, rules: ruleStore,
		ruleExplainer: ruleExplainer, ruleEvaluator: ruleEvaluator,
		externalEffects: effectStore,
		ruleSchedules:   ruleStore,
	}, nil
}

// NewInMemoryIntegrity is for tests and examples. It keeps no data beyond the
// process, so a Finding it opens disappears with it.
func NewInMemoryIntegrity() *IntegrityClient {
	ruleStore := memory.NewRuleStore()
	return &IntegrityClient{
		findings: memory.NewFindingStore(), rules: ruleStore,
		ruleSchedules: ruleStore,
	}
}

// ScanRequest asks for one bounded pass over a Rule's subjects.
type ScanRequest struct {
	RuleID string
	// SubjectID narrows the pass to a single business subject. It cannot be
	// combined with Cursor: one asks about one record, the other resumes a walk.
	SubjectID string
	// Cursor resumes a previous incomplete scan. Empty starts at the beginning.
	Cursor string
	// MaxPages bounds the pass. Zero uses DefaultScanMaxPages. Each page is
	// bounded by the Rule's own limit, so this bounds the whole command.
	MaxPages int
}

const (
	// DefaultScanMaxPages bounds a scan that did not ask for a page budget.
	DefaultScanMaxPages = 100
	// MaxScanPages bounds one command however many pages it asks for, so a
	// mistyped flag cannot turn an operator command into an unbounded scan.
	MaxScanPages = 10_000
)

// ScanSummary is what one bounded pass observed. Findings are deduplicated by
// invariant key, so a repeated violation folds into the Finding that already
// exists rather than opening a new one.
type ScanSummary struct {
	RuleID  string `json:"ruleId"`
	Version int    `json:"version"`
	Pages   int    `json:"pages"`
	// Observed is how many subjects the Rule looked at; Passed, Violated and
	// Unknown partition it.
	Observed int `json:"observed"`
	Passed   int `json:"passed"`
	Violated int `json:"violated"`
	// Unknown counts subjects the check could not conclude about. It is
	// reported separately because folding it into Passed is exactly how drift
	// hides behind an unreachable provider.
	Unknown int `json:"unknown"`
	// Findings counts the Findings this pass touched, whether it opened,
	// reopened or resolved them.
	Findings int `json:"findings"`
	// HasMore reports that the page budget ran out before the subjects did.
	// NextCursor resumes from where it stopped.
	HasMore    bool      `json:"hasMore"`
	NextCursor string    `json:"nextCursor,omitempty"`
	StartedAt  time.Time `json:"startedAt"`
	FinishedAt time.Time `json:"finishedAt"`
}

// Scan evaluates an enabled Rule page by page and folds what it sees into
// Findings.
//
// It is the first useful thing an evaluator can do: it needs no queue, no
// worker and no cutover, only a Rule and a database connection. It performs no
// recovery - a Finding is a statement that something is wrong, and deciding
// what to do about it stays with an operator.
//
// The pass is bounded twice over: by MaxPages here and by the Rule's own page
// limit underneath. Cancelling ctx stops it at a page boundary and returns what
// it has, so a scan is always interruptible without losing observations that
// were already committed.
func (c *IntegrityClient) Scan(ctx context.Context, request ScanRequest) (ScanSummary, error) {
	if c == nil || c.rules == nil {
		return ScanSummary{}, errors.New("rhinoq rule store is not configured")
	}
	if request.RuleID == "" {
		return ScanSummary{}, errors.New("rhinoq scan requires a rule id")
	}
	if request.SubjectID != "" && request.Cursor != "" {
		return ScanSummary{}, errors.New(
			"rhinoq scan takes either a subject or a cursor: one asks about a single record, the other resumes a walk")
	}
	maxPages := request.MaxPages
	if maxPages <= 0 {
		maxPages = DefaultScanMaxPages
	}
	if maxPages > MaxScanPages {
		return ScanSummary{}, errors.New("rhinoq scan page budget is too large")
	}
	service, err := c.ruleService()
	if err != nil {
		return ScanSummary{}, err
	}

	summary := ScanSummary{RuleID: request.RuleID, StartedAt: time.Now().UTC()}
	cursor := request.Cursor
	for summary.Pages < maxPages {
		if err := ctx.Err(); err != nil {
			summary.HasMore = true
			summary.NextCursor = cursor
			summary.FinishedAt = time.Now().UTC()
			return summary, err
		}
		evaluation, findings, err := service.Evaluate(ctx, request.RuleID, request.SubjectID, cursor)
		if err != nil {
			return summary, err
		}
		summary.Pages++
		summary.Findings += len(findings)
		for _, observation := range evaluation.Observations {
			summary.Observed++
			switch observation.Status {
			case rule.Violated:
				summary.Violated++
			case rule.Unknown:
				summary.Unknown++
			default:
				summary.Passed++
			}
		}
		cursor = evaluation.NextCursor
		if !evaluation.HasMore {
			summary.FinishedAt = time.Now().UTC()
			return summary, nil
		}
		// A single subject is one page by definition; anything more would be
		// the Rule reporting a cursor it should not have.
		if request.SubjectID != "" {
			break
		}
	}
	summary.HasMore = true
	summary.NextCursor = cursor
	summary.FinishedAt = time.Now().UTC()
	return summary, nil
}

// RunScheduler evaluates enabled Rules on their declared cadence until ctx is
// cancelled. It is the only long-running operation on this facade, and it still
// starts no worker: it claims Rule schedules, not jobs.
func (c *IntegrityClient) RunScheduler(ctx context.Context, config RuleSchedulerConfig) error {
	if c == nil || c.ruleSchedules == nil {
		return errors.New("rhinoq rule scheduler store is not configured")
	}
	service, err := c.ruleService()
	if err != nil {
		return err
	}
	scheduler, err := rulescheduler.New(rulescheduler.Config{
		Store: c.ruleSchedules,
		Evaluate: func(
			ctx context.Context, id string, version int, subjectID, cursor string,
		) (rule.Evaluation, error) {
			evaluation, _, err := service.EvaluateVersion(ctx, id, version, subjectID, cursor)
			return evaluation, err
		},
		Owner:        config.Owner,
		PollInterval: config.PollInterval, Lease: config.Lease,
		ErrorBackoff: config.ErrorBackoff, ClaimBatch: config.ClaimBatch,
		OnError: config.OnError,
	})
	if err != nil {
		return err
	}
	return scheduler.Run(ctx)
}

// SubjectRef names the business thing an invariant is about.
type SubjectRef struct {
	Type string `json:"type"`
	ID   string `json:"id"`
}

// ExecutionRef names the run that acted on a subject, in whatever system
// performed it: "bullmq", "temporal", "cron", "app", or "rhinoq" for RhinoQ's
// own runtime.
type ExecutionRef struct {
	SourceSystem string `json:"sourceSystem"`
	SourceID     string `json:"sourceId"`
}

// ExternalEffectRequest records something an execution RhinoQ did not run did
// to the outside world.
type ExternalEffectRequest struct {
	// Execution is required and must not claim to be a RhinoQ job: work RhinoQ
	// leased records its effects through the runtime, where a lease can fence
	// them.
	Execution ExecutionRef
	// Subject is optional but is what makes the entry findable later.
	Subject     SubjectRef
	BusinessKey string
	// Name is what was done ("charge-card", "upload-report"); IdempotencyKey is
	// what makes doing it twice detectable.
	Name           string
	IdempotencyKey string
	Irreversible   bool
	ExternalRef    string
}

// RecordExternalEffect writes one Effect Ledger entry for an execution another
// system ran.
//
// This is the no-cutover path: a BullMQ worker that just called a payment
// provider can record that it did, and a Rule can later ask whether the
// business state matches, without any of it going through a RhinoQ queue.
//
// It is deliberately weaker than the runtime path, and the difference matters.
// A RhinoQ execution holds a lease, so BeginEffect can refuse a write from a
// worker that already lost its job. An external execution has no lease, so
// nothing here can prove the caller still owns the work. What remains is
// deduplication on (execution, name, idempotency key): calling twice with the
// same key returns the first entry rather than recording a second.
func (c *IntegrityClient) RecordExternalEffect(
	ctx context.Context,
	request ExternalEffectRequest,
) (EffectEvidence, error) {
	if c == nil || c.externalEffects == nil {
		return EffectEvidence{}, errors.New("rhinoq effect store is not configured")
	}
	id, err := newEffectID()
	if err != nil {
		return EffectEvidence{}, err
	}
	record, err := effect.NewExternalRecord(
		effect.ID(id),
		correlation.ExecutionRef{
			SourceSystem: request.Execution.SourceSystem,
			SourceID:     request.Execution.SourceID,
		},
		correlation.SubjectRef{Type: request.Subject.Type, ID: request.Subject.ID},
		request.BusinessKey, request.Name, request.IdempotencyKey,
		request.Irreversible, time.Now().UTC(),
	)
	if err != nil {
		return EffectEvidence{}, err
	}
	record.ExternalRef = request.ExternalRef
	stored, err := c.externalEffects.BeginExternalEffect(ctx, record)
	if err != nil {
		return EffectEvidence{}, err
	}
	return publicEffect(stored), nil
}

// SubjectEffects reads the Effect Ledger for one business subject, whichever
// system produced the entries. It is the read half of the no-cutover path: an
// operator asks about a report, not about a job.
func (c *IntegrityClient) SubjectEffects(
	ctx context.Context,
	subject SubjectRef,
	offset, limit int,
) ([]EffectEvidence, error) {
	if c == nil || c.externalEffects == nil {
		return nil, errors.New("rhinoq effect store is not configured")
	}
	records, err := c.externalEffects.ListSubjectEffects(
		ctx, correlation.SubjectRef{Type: subject.Type, ID: subject.ID}, offset, limit,
	)
	if err != nil {
		return nil, err
	}
	evidence := make([]EffectEvidence, 0, len(records))
	for _, record := range records {
		evidence = append(evidence, publicEffect(record))
	}
	return evidence, nil
}

// newEffectID generates the identifier for an externally recorded effect.
// Unlike the runtime path, which derives a deterministic id from the job, an
// external caller has no such handle - so the id is random and the execution
// reference plus idempotency key is what deduplicates.
func newEffectID() (string, error) {
	buffer := make([]byte, 16)
	if _, err := rand.Read(buffer); err != nil {
		return "", err
	}
	return "effect_" + hex.EncodeToString(buffer), nil
}

func publicEffect(record effect.Record) EffectEvidence {
	return EffectEvidence{
		ID: string(record.ID), JobID: record.JobID, Name: record.Name,
		SourceSystem: record.Execution.SourceSystem,
		SourceID:     record.Execution.SourceID,
		SubjectType:  record.Subject.Type, SubjectID: record.Subject.ID,
		BusinessKey:    record.BusinessKey,
		IdempotencyKey: record.IdempotencyKey, State: string(record.State),
		Irreversible: record.Irreversible, ExternalRef: record.ExternalRef,
		CreatedAt: record.CreatedAt, LeaseEpoch: record.LeaseEpoch,
	}
}
