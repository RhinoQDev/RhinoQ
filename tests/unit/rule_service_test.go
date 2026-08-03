package unit

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
	"time"

	"github.com/madebyduy/RhinoQ/internal/adapters/memory"
	"github.com/madebyduy/RhinoQ/internal/application/rules"
	"github.com/madebyduy/RhinoQ/internal/domain/finding"
	"github.com/madebyduy/RhinoQ/internal/domain/rule"
	"github.com/madebyduy/RhinoQ/internal/ports"
)

// The Rules engine is beta.8's largest new surface and its application layer
// was the least covered code in the repository: Explain, Enable, Disable,
// Evaluate, EvaluateVersion and the whole observation-to-Finding projection had
// no test reaching them. That projection is where an inconclusive check either
// stays inconclusive or silently closes a real Finding.

type stubExplainer struct {
	explanation rule.Explanation
	err         error
	calls       int
}

func (s *stubExplainer) ExplainRule(context.Context, rule.Record) (rule.Explanation, error) {
	s.calls++
	return s.explanation, s.err
}

type stubEvaluator struct {
	evaluation rule.Evaluation
	err        error
	seen       []rule.Record
	cursors    []string
}

func (s *stubEvaluator) EvaluateRule(
	_ context.Context, record rule.Record, _ string, cursor string,
) (rule.Evaluation, error) {
	s.seen = append(s.seen, record)
	s.cursors = append(s.cursors, cursor)
	return s.evaluation, s.err
}

type ruleHarness struct {
	service   *rules.Service
	store     *memory.RuleStore
	findings  *memory.FindingStore
	explainer *stubExplainer
	evaluator *stubEvaluator
	now       time.Time
}

func newRuleHarness(t *testing.T, explainer *stubExplainer, evaluator *stubEvaluator) *ruleHarness {
	t.Helper()
	now := time.Date(2026, 8, 3, 14, 0, 0, 0, time.UTC)
	store := memory.NewRuleStore()
	findings := memory.NewFindingStore()
	outcomes := memory.NewSubjectOutcomeStore()
	// A nil stub must stay a nil interface, or the service's "is it configured"
	// check sees a non-nil interface holding a nil pointer and proceeds.
	var explainerPort ports.RuleExplainer
	if explainer != nil {
		explainerPort = explainer
	}
	var evaluatorPort ports.RuleEvaluator
	if evaluator != nil {
		evaluatorPort = evaluator
	}
	service, err := rules.New(store, explainerPort, evaluatorPort, findings, outcomes, func() time.Time { return now })
	if err != nil {
		t.Fatal(err)
	}
	return &ruleHarness{
		service: service, store: store, findings: findings,
		explainer: explainer, evaluator: evaluator, now: now,
	}
}

func (h *ruleHarness) register(t *testing.T, id string, mutate func(*rule.Record)) rule.Record {
	t.Helper()
	record := rule.Record{
		ID: id, Name: "Completed report has output", Scope: rule.TableScope,
		SubjectType: "report",
		Query: "SELECT id::text AS subject_id, output_url IS NULL AS violated, " +
			"'{}'::jsonb AS evidence FROM completed_reports " +
			"WHERE created_at >= $1 AND id::text > $2 ORDER BY id LIMIT $3",
		BaselineAt: h.now.Add(-time.Hour), Every: 5 * time.Minute,
	}
	if mutate != nil {
		mutate(&record)
	}
	saved, err := h.service.Register(context.Background(), record)
	if err != nil {
		t.Fatalf("register %s: %v", id, err)
	}
	return saved
}

func safeExplanation(at time.Time) rule.Explanation {
	return rule.Explanation{Safe: true, PlanCost: 12, EstimatedRows: 40, ExplainedAt: at, QueryHash: "hash-1"}
}

func TestExplainRefusesAnUnknownRuleAndAnUnconfiguredExplainer(t *testing.T) {
	t.Parallel()
	ctx := context.Background()

	withExplainer := newRuleHarness(t, &stubExplainer{}, nil)
	if _, _, err := withExplainer.service.Explain(ctx, "does-not-exist"); !errors.Is(err, ports.ErrRuleNotFound) {
		t.Fatalf("an unknown Rule must not be explained, got %v", err)
	}
	if _, _, err := withExplainer.service.Explain(ctx, ""); !errors.Is(err, rule.ErrInvalidRule) {
		t.Fatalf("an empty id must be refused, got %v", err)
	}

	// Without an explainer there is no plan evidence, and the service must say
	// so rather than return an empty Explanation that reads as "nothing found".
	none := newRuleHarness(t, nil, nil)
	none.register(t, "report-has-output", nil)
	record, explanation, err := none.service.Explain(ctx, "report-has-output")
	if err == nil {
		t.Fatal("an unconfigured explainer must be reported")
	}
	if record.ID != "report-has-output" {
		t.Fatalf("the Rule that could not be explained must still be returned: %+v", record)
	}
	if explanation.Safe {
		t.Fatalf("an absent explainer must never report a safe plan: %+v", explanation)
	}
}

func TestExplainStoresThePlanEvidenceItProduced(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	h := newRuleHarness(t, &stubExplainer{}, nil)
	registered := h.register(t, "report-has-output", nil)
	h.explainer.explanation = safeExplanation(h.now)

	record, explanation, err := h.service.Explain(ctx, registered.ID)
	if err != nil {
		t.Fatal(err)
	}
	if !explanation.Safe || record.Version != registered.Version {
		t.Fatalf("explain must answer for the version it read: record=%+v explanation=%+v", record, explanation)
	}

	stored, found, err := h.store.GetRuleExplanation(ctx, registered.ID, registered.Version)
	if err != nil || !found {
		t.Fatalf("the explanation must be durable: found=%v err=%v", found, err)
	}
	if stored.QueryHash != "hash-1" {
		t.Fatalf("the stored explanation must be the one produced: %+v", stored)
	}
}

func TestExplainPropagatesTheExplainerFailure(t *testing.T) {
	t.Parallel()
	boom := errors.New("EXPLAIN timed out")
	h := newRuleHarness(t, &stubExplainer{err: boom}, nil)
	registered := h.register(t, "report-has-output", nil)

	if _, _, err := h.service.Explain(context.Background(), registered.ID); !errors.Is(err, boom) {
		t.Fatalf("an explainer failure must reach the caller, got %v", err)
	}
	if _, found, _ := h.store.GetRuleExplanation(context.Background(), registered.ID, registered.Version); found {
		t.Fatal("a failed explain must not leave stale plan evidence behind")
	}
}

// Enabling is the moment a Rule starts running business SQL on a schedule. An
// unsafe plan must stop it there, and the Rule must stay in whatever status it
// already had.
func TestEnableRefusesAnUnsafePlanAndLeavesTheRuleAlone(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	h := newRuleHarness(t, &stubExplainer{}, nil)
	registered := h.register(t, "report-has-output", nil)
	h.explainer.explanation = rule.Explanation{
		Safe: false, PlanCost: 900_000, ExplainedAt: h.now,
		SeqScans: []rule.SeqScan{{Relation: "completed_reports", EstimatedRows: 4_000_000}},
		Reasons:  []string{"plan cost exceeds the configured budget"},
	}

	record, explanation, err := h.service.Enable(ctx, registered.ID)
	if !errors.Is(err, rule.ErrRuleUnsafe) {
		t.Fatalf("an unsafe plan must refuse the enable, got %v", err)
	}
	if explanation.Safe || len(explanation.Reasons) == 0 {
		t.Fatalf("the refusal must carry the evidence an operator has to act on: %+v", explanation)
	}
	if record.Status == rule.Enabled {
		t.Fatalf("the Rule must not be enabled: %+v", record)
	}

	current, found, err := h.store.GetRule(ctx, registered.ID)
	if err != nil || !found {
		t.Fatalf("rule lookup: found=%v err=%v", found, err)
	}
	if current.Status != rule.Draft {
		t.Fatalf("a refused enable must leave the stored status untouched, got %s", current.Status)
	}
}

func TestEnableThenDisableMovesTheStoredStatus(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	h := newRuleHarness(t, &stubExplainer{}, nil)
	registered := h.register(t, "report-has-output", nil)
	h.explainer.explanation = safeExplanation(h.now)

	enabled, _, err := h.service.Enable(ctx, registered.ID)
	if err != nil {
		t.Fatal(err)
	}
	if enabled.Status != rule.Enabled {
		t.Fatalf("a safe plan must enable the Rule, got %s", enabled.Status)
	}

	disabled, err := h.service.Disable(ctx, registered.ID)
	if err != nil {
		t.Fatal(err)
	}
	if disabled.Status != rule.Disabled {
		t.Fatalf("disable must stop the Rule, got %s", disabled.Status)
	}
	// Disable must not need an explainer round trip: an operator stopping a
	// Rule at 3am cannot be blocked by EXPLAIN.
	if h.explainer.calls != 1 {
		t.Fatalf("disable must not re-explain, explainer called %d times", h.explainer.calls)
	}
}

func TestDisableRefusesAnUnknownRule(t *testing.T) {
	t.Parallel()
	h := newRuleHarness(t, &stubExplainer{}, nil)
	if _, err := h.service.Disable(context.Background(), "does-not-exist"); !errors.Is(err, ports.ErrRuleNotFound) {
		t.Fatalf("an unknown Rule must not be disabled, got %v", err)
	}
}

func TestEvaluateRefusesAnUnknownRuleAndAnUnconfiguredEvaluator(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	h := newRuleHarness(t, nil, nil)
	if _, _, err := h.service.Evaluate(ctx, "does-not-exist", "", ""); !errors.Is(err, ports.ErrRuleNotFound) {
		t.Fatalf("an unknown Rule must not be evaluated, got %v", err)
	}
	registered := h.register(t, "report-has-output", nil)
	if _, _, err := h.service.Evaluate(ctx, registered.ID, "", ""); err == nil {
		t.Fatal("evaluation without an evaluator must be reported, not silently empty")
	}
}

func TestAViolatedObservationOpensAFinding(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	evaluator := &stubEvaluator{}
	h := newRuleHarness(t, &stubExplainer{}, evaluator)
	registered := h.register(t, "report-has-output", nil)
	evaluator.evaluation = rule.Evaluation{
		EvaluatedAt: h.now,
		Observations: []rule.Observation{
			{SubjectID: "report-1", Status: rule.Violated, Evidence: `{"hasOutput":false}`},
			{SubjectID: "report-2", Status: rule.Passed, Evidence: `{"hasOutput":true}`},
		},
	}

	evaluation, changed, err := h.service.Evaluate(ctx, registered.ID, "", "")
	if err != nil {
		t.Fatal(err)
	}
	if len(evaluation.Observations) != 2 {
		t.Fatalf("the evaluation must be returned intact: %+v", evaluation)
	}
	if len(changed) != 1 {
		t.Fatalf("exactly the violated subject must change, got %d: %+v", len(changed), changed)
	}
	if changed[0].SubjectID != "report-1" || changed[0].Status != finding.Open {
		t.Fatalf("the violated subject must open a Finding: %+v", changed[0])
	}
	if changed[0].ObservedInvariantVersion != registered.Version {
		t.Fatalf("a Finding must name the Rule version that observed it: %+v", changed[0])
	}
}

// An inconclusive check is not a pass. Under the default policy it records the
// observation and opens nothing, so a provider outage cannot close real drift.
func TestAnUnknownObservationOpensNothingUnderTheRetryPolicy(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	evaluator := &stubEvaluator{}
	h := newRuleHarness(t, &stubExplainer{}, evaluator)
	registered := h.register(t, "report-has-output", nil)
	if registered.OnUnknown != rule.UnknownRetries {
		t.Fatalf("the default unknown policy must be retry, got %s", registered.OnUnknown)
	}
	evaluator.evaluation = rule.Evaluation{
		EvaluatedAt: h.now,
		Observations: []rule.Observation{
			{SubjectID: "report-1", Status: rule.Unknown, Reason: "provider_timeout"},
		},
	}

	_, changed, err := h.service.Evaluate(ctx, registered.ID, "", "")
	if err != nil {
		t.Fatal(err)
	}
	if len(changed) != 0 {
		t.Fatalf("an inconclusive check must not project a Finding under the retry policy: %+v", changed)
	}
}

// Under the finding policy an unknown escalates, and the evidence has to say
// that RhinoQ could not look — not that it looked and found a violation.
func TestAnUnknownObservationEscalatesWithItsReasonRecorded(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	evaluator := &stubEvaluator{}
	h := newRuleHarness(t, &stubExplainer{}, evaluator)
	registered := h.register(t, "report-has-output", func(record *rule.Record) {
		record.OnUnknown = rule.UnknownOpensFinding
	})
	evaluator.evaluation = rule.Evaluation{
		EvaluatedAt: h.now,
		Observations: []rule.Observation{
			{SubjectID: "report-1", Status: rule.Unknown, Reason: "permission_denied", Evidence: `{"role":"reader"}`},
		},
	}

	_, changed, err := h.service.Evaluate(ctx, registered.ID, "", "")
	if err != nil {
		t.Fatal(err)
	}
	if len(changed) != 1 {
		t.Fatalf("an unknown under the finding policy must escalate, got %d", len(changed))
	}

	var evidence map[string]any
	if err := json.Unmarshal([]byte(changed[0].LatestEvidence), &evidence); err != nil {
		t.Fatalf("the escalated evidence must stay valid JSON: %v (%s)", err, changed[0].LatestEvidence)
	}
	if evidence["rhinoqObservation"] != string(rule.Unknown) {
		t.Fatalf("the Finding must say the check was inconclusive: %s", changed[0].LatestEvidence)
	}
	if evidence["rhinoqReason"] != "permission_denied" {
		t.Fatalf("the reason is what makes an unknown actionable: %s", changed[0].LatestEvidence)
	}
	if evidence["evidence"] == nil {
		t.Fatalf("whatever the query did return must be kept alongside the reason: %s", changed[0].LatestEvidence)
	}
}

// Grace exists so a Rule that polls every minute does not open a Finding for a
// blip. Nothing escalates until the streak outlives it.
func TestAnUnknownWithinItsGracePeriodDoesNotEscalate(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	evaluator := &stubEvaluator{}
	h := newRuleHarness(t, &stubExplainer{}, evaluator)
	registered := h.register(t, "report-has-output", func(record *rule.Record) {
		record.OnUnknown = rule.UnknownOpensFinding
		record.UnknownGrace = time.Hour
	})
	evaluator.evaluation = rule.Evaluation{
		EvaluatedAt: h.now,
		Observations: []rule.Observation{
			{SubjectID: "report-1", Status: rule.Unknown, Reason: "provider_timeout"},
		},
	}

	_, changed, err := h.service.Evaluate(ctx, registered.ID, "", "")
	if err != nil {
		t.Fatal(err)
	}
	if len(changed) != 0 {
		t.Fatalf("the first unknown must not escalate inside the grace window: %+v", changed)
	}

	// The streak continues past the grace window.
	evaluator.evaluation.EvaluatedAt = h.now.Add(2 * time.Hour)
	_, changed, err = h.service.Evaluate(ctx, registered.ID, "", "")
	if err != nil {
		t.Fatal(err)
	}
	if len(changed) != 1 {
		t.Fatalf("an unknown streak outliving its grace must escalate, got %d", len(changed))
	}
}

// The scheduler leases one immutable Rule version. If evaluation drifted to
// the newest draft, a lease would silently start running SQL nobody enabled.
func TestEvaluateVersionPinsTheVersionItWasGiven(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	evaluator := &stubEvaluator{}
	h := newRuleHarness(t, &stubExplainer{}, evaluator)
	first := h.register(t, "report-has-output", nil)
	second := h.register(t, "report-has-output", func(record *rule.Record) {
		record.Query = "SELECT id::text AS subject_id, false AS violated, '{}'::jsonb AS evidence " +
			"FROM completed_reports WHERE created_at >= $1 AND id::text > $2 ORDER BY id LIMIT $3"
	})
	if second.Version != first.Version+1 {
		t.Fatalf("the fixture needs two versions: %d then %d", first.Version, second.Version)
	}
	evaluator.evaluation = rule.Evaluation{EvaluatedAt: h.now}

	if _, _, err := h.service.EvaluateVersion(ctx, first.ID, first.Version, "", "page-2"); err != nil {
		t.Fatal(err)
	}
	if len(evaluator.seen) != 1 {
		t.Fatalf("expected one evaluation, got %d", len(evaluator.seen))
	}
	if evaluator.seen[0].Version != first.Version || evaluator.seen[0].Query != first.Query {
		t.Fatalf("the lease's version must be evaluated, not the newest draft: %+v", evaluator.seen[0])
	}
	if evaluator.cursors[0] != "page-2" {
		t.Fatalf("the resume cursor must reach the evaluator, got %q", evaluator.cursors[0])
	}

	if _, _, err := h.service.EvaluateVersion(ctx, first.ID, 99, "", ""); !errors.Is(err, ports.ErrRuleNotFound) {
		t.Fatalf("a version that does not exist must be refused, got %v", err)
	}
}

func TestEvaluatePropagatesTheEvaluatorFailure(t *testing.T) {
	t.Parallel()
	boom := errors.New("statement timeout")
	evaluator := &stubEvaluator{err: boom}
	h := newRuleHarness(t, &stubExplainer{}, evaluator)
	registered := h.register(t, "report-has-output", nil)

	_, changed, err := h.service.Evaluate(context.Background(), registered.ID, "", "")
	if !errors.Is(err, boom) {
		t.Fatalf("an evaluator failure must reach the caller, got %v", err)
	}
	if len(changed) != 0 {
		t.Fatalf("a failed evaluation must project nothing: %+v", changed)
	}
}
