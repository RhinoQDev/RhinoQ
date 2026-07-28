// Package rules coordinates versioned Rule definitions, PostgreSQL explain
// evidence, and safe enable/disable transitions.
package rules

import (
	"context"
	"errors"
	"time"

	"github.com/rhinoq/rhinoq/internal/domain/finding"
	"github.com/rhinoq/rhinoq/internal/domain/rule"
	"github.com/rhinoq/rhinoq/internal/ports"
)

type Service struct {
	store     ports.RuleStore
	explainer ports.RuleExplainer
	evaluator ports.RuleEvaluator
	findings  ports.FindingStore
	now       func() time.Time
}

func New(
	store ports.RuleStore,
	explainer ports.RuleExplainer,
	evaluator ports.RuleEvaluator,
	findings ports.FindingStore,
	now func() time.Time,
) (*Service, error) {
	if store == nil {
		return nil, errors.New("rule store is required")
	}
	if now == nil {
		now = func() time.Time { return time.Now().UTC() }
	}
	return &Service{
		store: store, explainer: explainer, evaluator: evaluator,
		findings: findings, now: now,
	}, nil
}

// Register appends a new immutable Rule version. Existing enabled versions
// continue running until the new draft passes Explain and is enabled.
func (s *Service) Register(ctx context.Context, record rule.Record) (rule.Record, error) {
	current, found, err := s.store.GetRule(ctx, record.ID)
	if err != nil {
		return rule.Record{}, err
	}
	nextVersion := 1
	if found {
		nextVersion = current.Version + 1
	}
	now := s.now()
	record.Version = nextVersion
	record.Status = rule.Draft
	record.CreatedAt = now
	record.UpdatedAt = now
	record = record.WithDefaults()
	if err := record.Validate(); err != nil {
		return rule.Record{}, err
	}
	return s.store.SaveRule(ctx, record)
}

func (s *Service) Get(ctx context.Context, id string) (rule.Record, bool, error) {
	if id == "" {
		return rule.Record{}, false, rule.ErrInvalidRule
	}
	return s.store.GetRule(ctx, id)
}

func (s *Service) List(ctx context.Context, query rule.Query) ([]rule.Record, error) {
	if err := query.Validate(); err != nil {
		return nil, err
	}
	return s.store.ListRules(ctx, query)
}

func (s *Service) Explain(
	ctx context.Context,
	id string,
) (rule.Record, rule.Explanation, error) {
	record, found, err := s.Get(ctx, id)
	if err != nil {
		return rule.Record{}, rule.Explanation{}, err
	}
	if !found {
		return rule.Record{}, rule.Explanation{}, ports.ErrRuleNotFound
	}
	if s.explainer == nil {
		return record, rule.Explanation{}, errors.New("PostgreSQL rule explainer is not configured")
	}
	explanation, err := s.explainer.ExplainRule(ctx, record)
	if err != nil {
		return record, rule.Explanation{}, err
	}
	if err := s.store.SaveRuleExplanation(ctx, record.ID, record.Version, explanation); err != nil {
		return record, rule.Explanation{}, err
	}
	return record, explanation, nil
}

func (s *Service) Enable(
	ctx context.Context,
	id string,
) (rule.Record, rule.Explanation, error) {
	record, explanation, err := s.Explain(ctx, id)
	if err != nil {
		return rule.Record{}, rule.Explanation{}, err
	}
	if !explanation.Safe {
		return record, explanation, rule.ErrRuleUnsafe
	}
	record, err = s.store.SetRuleStatus(
		ctx, record.ID, record.Version, rule.Enabled, s.now(),
	)
	return record, explanation, err
}

func (s *Service) Disable(ctx context.Context, id string) (rule.Record, error) {
	record, found, err := s.Get(ctx, id)
	if err != nil {
		return rule.Record{}, err
	}
	if !found {
		return rule.Record{}, ports.ErrRuleNotFound
	}
	return s.store.SetRuleStatus(
		ctx, record.ID, record.Version, rule.Disabled, s.now(),
	)
}

func (s *Service) Evaluate(
	ctx context.Context,
	id, subjectID, cursor string,
) (rule.Evaluation, []finding.Record, error) {
	record, found, err := s.Get(ctx, id)
	if err != nil {
		return rule.Evaluation{}, nil, err
	}
	if !found {
		return rule.Evaluation{}, nil, ports.ErrRuleNotFound
	}
	if s.evaluator == nil || s.findings == nil {
		return rule.Evaluation{}, nil, errors.New(
			"PostgreSQL rule evaluator and finding store are required",
		)
	}
	evaluation, err := s.evaluator.EvaluateRule(ctx, record, subjectID, cursor)
	if err != nil {
		return rule.Evaluation{}, nil, err
	}
	changed := make([]finding.Record, 0, len(evaluation.Observations))
	for _, observation := range evaluation.Observations {
		key := finding.Key{
			RuleID: record.ID, SubjectType: record.SubjectType,
			SubjectID:                observation.SubjectID,
			ObservedInvariantVersion: record.Version,
		}
		if observation.Violated {
			item, err := s.findings.ObserveFinding(ctx, finding.Observation{
				Key: key, Evidence: observation.Evidence,
				ObservedAt: evaluation.EvaluatedAt,
			})
			if err != nil {
				return evaluation, changed, err
			}
			changed = append(changed, item)
			continue
		}
		item, didChange, err := s.findings.ObserveFindingPass(
			ctx, key, evaluation.EvaluatedAt,
		)
		if err != nil {
			return evaluation, changed, err
		}
		if didChange {
			changed = append(changed, item)
		}
	}
	return evaluation, changed, nil
}
