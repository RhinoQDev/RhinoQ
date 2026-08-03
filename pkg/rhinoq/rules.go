package rhinoq

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	ruleapp "github.com/madebyduy/RhinoQ/internal/application/rules"
	"github.com/madebyduy/RhinoQ/internal/domain/finding"
	"github.com/madebyduy/RhinoQ/internal/domain/rule"
	"github.com/madebyduy/RhinoQ/internal/domain/subjectoutcome"
	"github.com/madebyduy/RhinoQ/internal/ports"
)

const (
	RuleScopeJob   = "job"
	RuleScopeTable = "table"

	RuleDraft    = "draft"
	RuleEnabled  = "enabled"
	RuleDisabled = "disabled"
)

var (
	ErrRuleUnsafe      = rule.ErrRuleUnsafe
	ErrRuleInvalid     = rule.ErrInvalidRule
	ErrRuleUnsafeQuery = rule.ErrUnsafeQuery
	ErrRuleNotFound    = ports.ErrRuleNotFound
)

type RuleDefinition struct {
	ID          string        `json:"id"`
	Name        string        `json:"name"`
	Scope       string        `json:"scope"`
	SubjectType string        `json:"subjectType"`
	JobName     string        `json:"jobName,omitempty"`
	Query       string        `json:"query"`
	BaselineAt  time.Time     `json:"baselineAt"`
	Every       time.Duration `json:"-"`
	Within      time.Duration `json:"-"`
	// Cursor is "subject" (default) or "changed": how a table Rule walks its
	// subjects. A changed-since Rule must accept $5, the cursor timestamp, and
	// return a changed_at column.
	Cursor string `json:"cursor"`
	// OnUnknown is "retry" (default) or "finding": what an inconclusive
	// observation does.
	OnUnknown string `json:"onUnknown"`
	// UnknownGrace waits for a continuous unknown streak before opening a
	// Finding. Zero opens immediately when OnUnknown is "finding".
	UnknownGrace time.Duration `json:"-"`
	MaxRows      int           `json:"maxRows"`

	StatementTimeout time.Duration `json:"-"`
	MaxPlanCost      float64       `json:"maxPlanCost"`
	MaxSeqScanRows   int64         `json:"maxSeqScanRows"`
}

type RuleRecord struct {
	RuleDefinition
	Version   int       `json:"version"`
	Status    string    `json:"status"`
	CreatedAt time.Time `json:"createdAt"`
	UpdatedAt time.Time `json:"updatedAt"`
}

// MarshalJSON is the wire contract for RuleRecord. Durations are represented
// in milliseconds because the Agent request contract uses *Ms fields; letting
// encoding/json marshal time.Duration would leak Go's nanosecond unit and
// silently make clients schedule rules 1,000,000 times too slowly.
func (r RuleRecord) MarshalJSON() ([]byte, error) {
	type wire struct {
		ID                 string    `json:"id"`
		Name               string    `json:"name"`
		Scope              string    `json:"scope"`
		Status             string    `json:"status"`
		SubjectType        string    `json:"subjectType"`
		JobName            string    `json:"jobName,omitempty"`
		Query              string    `json:"query"`
		BaselineAt         time.Time `json:"baselineAt"`
		EveryMs            int64     `json:"everyMs"`
		WithinMs           int64     `json:"withinMs"`
		MaxRows            int       `json:"maxRows"`
		OnUnknown          string    `json:"onUnknown"`
		UnknownGraceMs     int64     `json:"unknownGraceMs"`
		Cursor             string    `json:"cursor"`
		StatementTimeoutMs int64     `json:"statementTimeoutMs"`
		MaxPlanCost        float64   `json:"maxPlanCost"`
		MaxSeqScanRows     int64     `json:"maxSeqScanRows"`
		Version            int       `json:"version"`
		CreatedAt          time.Time `json:"createdAt"`
		UpdatedAt          time.Time `json:"updatedAt"`
	}
	return json.Marshal(wire{
		ID: r.ID, Name: r.Name, Scope: r.Scope, Status: r.Status,
		SubjectType: r.SubjectType, JobName: r.JobName, Query: r.Query,
		BaselineAt: r.BaselineAt, EveryMs: r.Every.Milliseconds(),
		WithinMs: r.Within.Milliseconds(), MaxRows: r.MaxRows,
		OnUnknown: r.OnUnknown, UnknownGraceMs: r.UnknownGrace.Milliseconds(),
		Cursor: r.Cursor, StatementTimeoutMs: r.StatementTimeout.Milliseconds(),
		MaxPlanCost: r.MaxPlanCost, MaxSeqScanRows: r.MaxSeqScanRows,
		Version: r.Version, CreatedAt: r.CreatedAt, UpdatedAt: r.UpdatedAt,
	})
}

type RuleQuery struct {
	Scope       string
	SubjectType string
	Statuses    []string
	Offset      int
	Limit       int
}

type RuleSeqScan struct {
	Relation      string `json:"relation"`
	EstimatedRows int64  `json:"estimatedRows"`
}

type RuleExplanation struct {
	Safe          bool          `json:"safe"`
	PlanCost      float64       `json:"planCost"`
	EstimatedRows int64         `json:"estimatedRows"`
	SeqScans      []RuleSeqScan `json:"seqScans"`
	Reasons       []string      `json:"reasons"`
	ExplainedAt   time.Time     `json:"explainedAt"`
	QueryHash     string        `json:"queryHash"`
}

// Observation statuses. A check has three possible conclusions, not two: a
// provider that timed out or an object RhinoQ may not read is not a pass.
const (
	ObservationPassed   = string(rule.Passed)
	ObservationViolated = string(rule.Violated)
	ObservationUnknown  = string(rule.Unknown)
)

// Unknown policies decide what an inconclusive observation does.
const (
	// UnknownRetries records the observation and opens nothing; the next
	// evaluation asks again. Default.
	UnknownRetries = string(rule.UnknownRetries)
	// UnknownOpensFinding treats not knowing as drift needing a person.
	UnknownOpensFinding = string(rule.UnknownOpensFinding)
)

// Cursor modes decide how a table Rule walks its subjects.
const (
	// CursorSubject pages by subject id: bounded, complete, blind to recency.
	CursorSubject = string(rule.CursorSubject)
	// CursorChanged pages by (changed_at, subject_id), so a row that just moved
	// is seen on the next page rather than after a full pass.
	CursorChanged = string(rule.CursorChanged)
)

type RuleObservation struct {
	SubjectID string `json:"subjectId"`
	// Status is passed, violated or unknown.
	Status string `json:"status"`
	// Reason is set only when Status is unknown, and names why the check could
	// not conclude.
	Reason   string `json:"reason,omitempty"`
	Evidence string `json:"evidence,omitempty"`
}

type RuleEvaluation struct {
	Observations []RuleObservation `json:"observations"`
	NextCursor   string            `json:"nextCursor,omitempty"`
	HasMore      bool              `json:"hasMore"`
	EvaluatedAt  time.Time         `json:"evaluatedAt"`
	Findings     []FindingRecord   `json:"findings"`
}

// IntegrityState is the canonical integrity state for one immutable Rule
// version and one business subject. Outcome always records the latest
// observation. Finding is present only when that Outcome currently needs
// operational attention (or has lifecycle history).
type IntegrityState struct {
	RuleID         string         `json:"ruleId"`
	RuleVersion    int            `json:"ruleVersion"`
	Subject        SubjectRef     `json:"subject"`
	Status         string         `json:"status"`
	Reason         string         `json:"reason,omitempty"`
	Evidence       string         `json:"evidence,omitempty"`
	FirstUnknownAt time.Time      `json:"firstUnknownAt,omitempty"`
	LastObservedAt time.Time      `json:"lastObservedAt"`
	UnknownCount   int            `json:"unknownCount"`
	Finding        *FindingRecord `json:"finding,omitempty"`
}

// GetIntegrityState reads Outcome first and joins the optional Finding by the
// same canonical key. Findings are a workflow projection, never a second
// source of truth for whether the invariant passed, violated or was unknown.
func (c *IntegrityClient) GetIntegrityState(
	ctx context.Context,
	ruleID string,
	ruleVersion int,
	subject SubjectRef,
) (IntegrityState, bool, error) {
	if c == nil || c.subjectOutcomes == nil || c.findings == nil {
		return IntegrityState{}, false, errors.New(
			"rhinoq integrity state stores are not configured",
		)
	}
	key := subjectoutcome.Key{
		RuleID: ruleID, RuleVersion: ruleVersion,
		SubjectType: subject.Type, SubjectID: subject.ID,
	}
	outcome, found, err := c.subjectOutcomes.GetSubjectOutcome(ctx, key)
	if err != nil || !found {
		return IntegrityState{}, found, err
	}
	state := IntegrityState{
		RuleID: outcome.RuleID, RuleVersion: outcome.RuleVersion,
		Subject: SubjectRef{Type: outcome.SubjectType, ID: outcome.SubjectID},
		Status:  string(outcome.Status), Reason: outcome.Reason,
		Evidence: outcome.Evidence, FirstUnknownAt: outcome.FirstUnknownAt,
		LastObservedAt: outcome.LastObservedAt, UnknownCount: outcome.UnknownCount,
	}
	item, hasFinding, err := c.findings.GetFinding(ctx, finding.Key{
		RuleID: ruleID, ObservedInvariantVersion: ruleVersion,
		SubjectType: subject.Type, SubjectID: subject.ID,
	})
	if err != nil {
		return IntegrityState{}, false, err
	}
	if hasFinding {
		public := summarizeFinding(item)
		state.Finding = &public
	}
	return state, true, nil
}

func (c *IntegrityClient) RegisterRule(
	ctx context.Context,
	definition RuleDefinition,
) (RuleRecord, error) {
	service, err := c.ruleService()
	if err != nil {
		return RuleRecord{}, err
	}
	record, err := service.Register(ctx, domainRule(definition))
	return publicRule(record), err
}

func (c *IntegrityClient) ListRules(ctx context.Context, query RuleQuery) ([]RuleRecord, error) {
	service, err := c.ruleService()
	if err != nil {
		return nil, err
	}
	statuses := make([]rule.Status, 0, len(query.Statuses))
	for _, status := range query.Statuses {
		statuses = append(statuses, rule.Status(status))
	}
	records, err := service.List(ctx, rule.Query{
		Scope: rule.Scope(query.Scope), SubjectType: query.SubjectType,
		Statuses: statuses,
		Offset:   query.Offset, Limit: query.Limit,
	})
	if err != nil {
		return nil, err
	}
	result := make([]RuleRecord, 0, len(records))
	for _, record := range records {
		result = append(result, publicRule(record))
	}
	return result, nil
}

func (c *IntegrityClient) ExplainRule(
	ctx context.Context,
	id string,
) (RuleRecord, RuleExplanation, error) {
	service, err := c.ruleService()
	if err != nil {
		return RuleRecord{}, RuleExplanation{}, err
	}
	record, explanation, err := service.Explain(ctx, id)
	return publicRule(record), publicExplanation(explanation), err
}

func (c *IntegrityClient) EnableRule(
	ctx context.Context,
	id string,
) (RuleRecord, RuleExplanation, error) {
	service, err := c.ruleService()
	if err != nil {
		return RuleRecord{}, RuleExplanation{}, err
	}
	record, explanation, err := service.Enable(ctx, id)
	return publicRule(record), publicExplanation(explanation), err
}

func (c *IntegrityClient) DisableRule(ctx context.Context, id string) (RuleRecord, error) {
	service, err := c.ruleService()
	if err != nil {
		return RuleRecord{}, err
	}
	record, err := service.Disable(ctx, id)
	return publicRule(record), err
}

func (c *IntegrityClient) EvaluateRule(
	ctx context.Context,
	id, subjectID, cursor string,
) (RuleEvaluation, error) {
	service, err := c.ruleService()
	if err != nil {
		return RuleEvaluation{}, err
	}
	evaluation, findings, err := service.Evaluate(ctx, id, subjectID, cursor)
	if err != nil {
		return RuleEvaluation{}, err
	}
	observations := make([]RuleObservation, 0, len(evaluation.Observations))
	for _, observation := range evaluation.Observations {
		observations = append(observations, RuleObservation{
			SubjectID: observation.SubjectID,
			Status:    string(observation.Status),
			Reason:    observation.Reason,
			Evidence:  observation.Evidence,
		})
	}
	publicFindings := make([]FindingRecord, 0, len(findings))
	for _, item := range findings {
		publicFindings = append(publicFindings, summarizeFinding(item))
	}
	return RuleEvaluation{
		Observations: observations, NextCursor: evaluation.NextCursor,
		HasMore: evaluation.HasMore, EvaluatedAt: evaluation.EvaluatedAt,
		Findings: publicFindings,
	}, nil
}

func (c *IntegrityClient) ruleService() (*ruleapp.Service, error) {
	if c == nil || c.rules == nil {
		return nil, errors.New("rhinoq rule store is not configured")
	}
	return ruleapp.New(
		c.rules, c.ruleExplainer, c.ruleEvaluator, c.findings,
		c.subjectOutcomes,
		func() time.Time { return time.Now().UTC() },
	)
}

func domainRule(definition RuleDefinition) rule.Record {
	return rule.Record{
		ID: definition.ID, Name: definition.Name,
		Scope: rule.Scope(definition.Scope), SubjectType: definition.SubjectType,
		JobName: definition.JobName, Query: definition.Query,
		BaselineAt: definition.BaselineAt, Every: definition.Every,
		Within: definition.Within, MaxRows: definition.MaxRows,
		OnUnknown:        rule.UnknownPolicy(definition.OnUnknown),
		UnknownGrace:     definition.UnknownGrace,
		Cursor:           rule.CursorMode(definition.Cursor),
		StatementTimeout: definition.StatementTimeout,
		MaxPlanCost:      definition.MaxPlanCost,
		MaxSeqScanRows:   definition.MaxSeqScanRows,
	}
}

func publicRule(record rule.Record) RuleRecord {
	return RuleRecord{
		RuleDefinition: RuleDefinition{
			ID: record.ID, Name: record.Name, Scope: string(record.Scope),
			SubjectType: record.SubjectType, JobName: record.JobName,
			Query: record.Query, BaselineAt: record.BaselineAt,
			Every: record.Every, Within: record.Within, MaxRows: record.MaxRows,
			OnUnknown:        string(record.OnUnknown),
			Cursor:           string(record.Cursor),
			UnknownGrace:     record.UnknownGrace,
			StatementTimeout: record.StatementTimeout,
			MaxPlanCost:      record.MaxPlanCost, MaxSeqScanRows: record.MaxSeqScanRows,
		},
		Version: record.Version, Status: string(record.Status),
		CreatedAt: record.CreatedAt, UpdatedAt: record.UpdatedAt,
	}
}

func publicExplanation(explanation rule.Explanation) RuleExplanation {
	seqScans := make([]RuleSeqScan, 0, len(explanation.SeqScans))
	for _, scan := range explanation.SeqScans {
		seqScans = append(seqScans, RuleSeqScan{
			Relation: scan.Relation, EstimatedRows: scan.EstimatedRows,
		})
	}
	return RuleExplanation{
		Safe: explanation.Safe, PlanCost: explanation.PlanCost,
		EstimatedRows: explanation.EstimatedRows, SeqScans: seqScans,
		Reasons:     append([]string(nil), explanation.Reasons...),
		ExplainedAt: explanation.ExplainedAt, QueryHash: explanation.QueryHash,
	}
}
