package rhinoq

import (
	"context"
	"errors"
	"time"

	ruleapp "github.com/rhinoq/rhinoq/internal/application/rules"
	"github.com/rhinoq/rhinoq/internal/domain/rule"
	"github.com/rhinoq/rhinoq/internal/ports"
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
	ID          string
	Name        string
	Scope       string
	SubjectType string
	JobName     string
	Query       string
	BaselineAt  time.Time
	Every       time.Duration
	Within      time.Duration
	MaxRows     int

	StatementTimeout time.Duration
	MaxPlanCost      float64
	MaxSeqScanRows   int64
}

type RuleRecord struct {
	RuleDefinition
	Version   int       `json:"version"`
	Status    string    `json:"status"`
	CreatedAt time.Time `json:"createdAt"`
	UpdatedAt time.Time `json:"updatedAt"`
}

type RuleQuery struct {
	Scope    string
	Statuses []string
	Offset   int
	Limit    int
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

type RuleObservation struct {
	SubjectID string `json:"subjectId"`
	Violated  bool   `json:"violated"`
	Evidence  string `json:"evidence,omitempty"`
}

type RuleEvaluation struct {
	Observations []RuleObservation `json:"observations"`
	NextCursor   string            `json:"nextCursor,omitempty"`
	HasMore      bool              `json:"hasMore"`
	EvaluatedAt  time.Time         `json:"evaluatedAt"`
	Findings     []FindingRecord   `json:"findings"`
}

func (c *Client) RegisterRule(
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

func (c *Client) ListRules(ctx context.Context, query RuleQuery) ([]RuleRecord, error) {
	service, err := c.ruleService()
	if err != nil {
		return nil, err
	}
	statuses := make([]rule.Status, 0, len(query.Statuses))
	for _, status := range query.Statuses {
		statuses = append(statuses, rule.Status(status))
	}
	records, err := service.List(ctx, rule.Query{
		Scope: rule.Scope(query.Scope), Statuses: statuses,
		Offset: query.Offset, Limit: query.Limit,
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

func (c *Client) ExplainRule(
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

func (c *Client) EnableRule(
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

func (c *Client) DisableRule(ctx context.Context, id string) (RuleRecord, error) {
	service, err := c.ruleService()
	if err != nil {
		return RuleRecord{}, err
	}
	record, err := service.Disable(ctx, id)
	return publicRule(record), err
}

func (c *Client) EvaluateRule(
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
			SubjectID: observation.SubjectID, Violated: observation.Violated,
			Evidence: observation.Evidence,
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

func (c *Client) ruleService() (*ruleapp.Service, error) {
	if c == nil || c.rules == nil {
		return nil, errors.New("rhinoq rule store is not configured")
	}
	return ruleapp.New(
		c.rules, c.ruleExplainer, c.ruleEvaluator, c.findings,
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
