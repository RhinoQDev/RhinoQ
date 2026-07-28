package rhinoq

import (
	"context"
	"database/sql"
	"errors"
	"time"

	"github.com/madebyduy/RhinoQ/internal/adapters/memory"
	"github.com/madebyduy/RhinoQ/internal/adapters/postgres"
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
	ruleEvaluator, err := postgres.NewRuleEvaluator(db, nil)
	if err != nil {
		return nil, err
	}
	return &IntegrityClient{
		findings: findingStore, rules: ruleStore,
		ruleExplainer: ruleExplainer, ruleEvaluator: ruleEvaluator,
		ruleSchedules: ruleStore,
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
	// Observed is how many subjects the Rule looked at; Passed and Violated
	// partition it.
	Observed int `json:"observed"`
	Passed   int `json:"passed"`
	Violated int `json:"violated"`
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
			if observation.Violated {
				summary.Violated++
			} else {
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
