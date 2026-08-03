// Package rules coordinates versioned Rule definitions, PostgreSQL explain
// evidence, and safe enable/disable transitions.
package rules

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/madebyduy/RhinoQ/internal/domain/finding"
	"github.com/madebyduy/RhinoQ/internal/domain/rule"
	"github.com/madebyduy/RhinoQ/internal/domain/subjectoutcome"
	"github.com/madebyduy/RhinoQ/internal/ports"
)

type Service struct {
	store     ports.RuleStore
	explainer ports.RuleExplainer
	evaluator ports.RuleEvaluator
	findings  ports.FindingStore
	outcomes  ports.SubjectOutcomeStore
	now       func() time.Time
}

func New(
	store ports.RuleStore,
	explainer ports.RuleExplainer,
	evaluator ports.RuleEvaluator,
	findings ports.FindingStore,
	outcomes ports.SubjectOutcomeStore,
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
		findings: findings, outcomes: outcomes, now: now,
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

// Delete removes a Rule definition and everything derived from it.
//
// Evaluation is where people create Rules they never meant to keep, and a list
// that can only grow is a list nobody cleans. The store enforces the two rules
// that matter: an enabled Rule must be disabled first, because deleting it
// silently stops a check somebody is relying on, and a Rule that has opened
// Findings keeps them unless the caller says otherwise, because a Finding
// records an operator decision that outlives the query which produced it.
func (s *Service) Delete(
	ctx context.Context,
	request rule.DeleteRequest,
) (rule.Deletion, error) {
	if err := request.Validate(); err != nil {
		return rule.Deletion{}, err
	}
	return s.store.DeleteRule(ctx, request)
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
	return s.evaluateRecord(ctx, record, subjectID, cursor)
}

// EvaluateVersion is used by the durable scheduler: a lease names one
// immutable Rule version and must never drift to a newer draft with the same ID.
func (s *Service) EvaluateVersion(
	ctx context.Context,
	id string,
	version int,
	subjectID, cursor string,
) (rule.Evaluation, []finding.Record, error) {
	record, found, err := s.store.GetRuleVersion(ctx, id, version)
	if err != nil {
		return rule.Evaluation{}, nil, err
	}
	if !found {
		return rule.Evaluation{}, nil, ports.ErrRuleNotFound
	}
	return s.evaluateRecord(ctx, record, subjectID, cursor)
}

func (s *Service) evaluateRecord(
	ctx context.Context,
	record rule.Record,
	subjectID, cursor string,
) (rule.Evaluation, []finding.Record, error) {
	if s.evaluator == nil || s.findings == nil || s.outcomes == nil {
		return rule.Evaluation{}, nil, errors.New(
			"Rule evaluator, subject outcome store and finding store are required",
		)
	}
	evaluation, err := s.evaluator.EvaluateRule(ctx, record, subjectID, cursor)
	if err != nil {
		return rule.Evaluation{}, nil, err
	}
	changed := make([]finding.Record, 0, len(evaluation.Observations))
	for _, observation := range evaluation.Observations {
		outcomeKey := subjectoutcome.Key{
			RuleID: record.ID, RuleVersion: record.Version,
			SubjectType: record.SubjectType, SubjectID: observation.SubjectID,
		}
		existingOutcome, found, err := s.outcomes.GetSubjectOutcome(
			ctx, outcomeKey,
		)
		if err != nil {
			return evaluation, changed, err
		}
		materialized, err := subjectoutcome.Apply(
			existingOutcome, found, outcomeKey, observation,
			evaluation.EvaluatedAt,
		)
		if err != nil {
			return evaluation, changed, err
		}
		applied, err := s.outcomes.SaveSubjectOutcome(ctx, materialized)
		if err != nil {
			return evaluation, changed, err
		}
		if !applied {
			// Scan and Changed may overlap. A stale observation is evidence
			// about the past and must not mutate today's Finding projection.
			continue
		}
		key := finding.Key{
			RuleID: record.ID, SubjectType: record.SubjectType,
			SubjectID:                observation.SubjectID,
			ObservedInvariantVersion: record.Version,
		}
		switch observation.Status {
		case rule.Violated:
			item, err := s.findings.ObserveFinding(ctx, finding.Observation{
				Key: key, Evidence: observation.Evidence,
				ObservedAt: evaluation.EvaluatedAt,
			})
			if err != nil {
				return evaluation, changed, err
			}
			changed = append(changed, item)

		case rule.Unknown:
			// An inconclusive check is not a pass. Resolving a Finding here
			// would close real drift because a provider happened to be
			// unreachable, which is the specific mistake a boolean forced.
			if record.OnUnknown != rule.UnknownOpensFinding {
				continue
			}
			if !materialized.UnknownEscalationDue(
				record.UnknownGrace, evaluation.EvaluatedAt,
			) {
				continue
			}
			item, err := s.findings.ObserveFinding(ctx, finding.Observation{
				Key: key, Evidence: unknownEvidence(observation),
				ObservedAt: evaluation.EvaluatedAt,
			})
			if err != nil {
				return evaluation, changed, err
			}
			changed = append(changed, item)

		default:
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
	}
	return evaluation, changed, nil
}

// unknownEvidence records why the check could not conclude alongside whatever
// the query returned, so an operator reading the Finding can tell "we looked
// and it was wrong" apart from "we could not look".
func unknownEvidence(observation rule.Observation) string {
	marker, err := json.Marshal(map[string]any{
		"rhinoqObservation": string(rule.Unknown),
		"rhinoqReason":      observation.Reason,
		"evidence":          json.RawMessage(observation.Evidence),
	})
	if err != nil {
		// Evidence that is not valid JSON must not lose the reason with it.
		fallback, _ := json.Marshal(map[string]any{
			"rhinoqObservation": string(rule.Unknown),
			"rhinoqReason":      observation.Reason,
			"evidence":          observation.Evidence,
		})
		return string(fallback)
	}
	return string(marker)
}
