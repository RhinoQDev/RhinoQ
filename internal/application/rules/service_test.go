package rules

import (
	"context"
	"strconv"
	"testing"
	"time"

	"github.com/madebyduy/RhinoQ/internal/domain/finding"
	"github.com/madebyduy/RhinoQ/internal/domain/rule"
	"github.com/madebyduy/RhinoQ/internal/domain/subjectoutcome"
	"github.com/madebyduy/RhinoQ/internal/ports"
)

// The fakes below count calls rather than simulating storage faithfully,
// because the property under test is how many times the service reaches for the
// database per page. Evaluating a page one subject at a time was correct and
// unusably slow: six round trips for a subject that turned out to be fine.

type countingOutcomes struct {
	records map[string]subjectoutcome.Record

	singleGets, singleSaves int
	batchGets, batchSaves   int
	largestBatch            int
}

func newCountingOutcomes() *countingOutcomes {
	return &countingOutcomes{records: map[string]subjectoutcome.Record{}}
}

func (s *countingOutcomes) GetSubjectOutcome(
	_ context.Context, key subjectoutcome.Key,
) (subjectoutcome.Record, bool, error) {
	s.singleGets++
	record, found := s.records[key.SubjectID]
	return record, found, nil
}

func (s *countingOutcomes) SaveSubjectOutcome(
	_ context.Context, record subjectoutcome.Record,
) (bool, error) {
	s.singleSaves++
	s.records[record.SubjectID] = record
	return true, nil
}

func (s *countingOutcomes) GetSubjectOutcomes(
	_ context.Context, keys []subjectoutcome.Key,
) (map[string]subjectoutcome.Record, error) {
	s.batchGets++
	if len(keys) > s.largestBatch {
		s.largestBatch = len(keys)
	}
	found := make(map[string]subjectoutcome.Record, len(keys))
	for _, key := range keys {
		if record, ok := s.records[key.SubjectID]; ok {
			found[key.SubjectID] = record
		}
	}
	return found, nil
}

func (s *countingOutcomes) SaveSubjectOutcomes(
	_ context.Context, records []subjectoutcome.Record,
) (map[string]bool, error) {
	s.batchSaves++
	applied := make(map[string]bool, len(records))
	for _, record := range records {
		s.records[record.SubjectID] = record
		applied[record.SubjectID] = true
	}
	return applied, nil
}

type countingFindings struct {
	records map[string]finding.Record

	observes, passes, batchGets int
}

func newCountingFindings() *countingFindings {
	return &countingFindings{records: map[string]finding.Record{}}
}

func (s *countingFindings) ObserveFinding(
	_ context.Context, observation finding.Observation,
) (finding.Record, error) {
	s.observes++
	record := finding.Record{
		Key: observation.Key, Status: finding.Open,
		LatestEvidence: observation.Evidence,
		FirstSeen:      observation.ObservedAt, LastSeen: observation.ObservedAt,
		OccurrenceCount: s.records[observation.Key.SubjectID].OccurrenceCount + 1,
	}
	s.records[observation.Key.SubjectID] = record
	return record, nil
}

func (s *countingFindings) ObserveFindingPass(
	_ context.Context, key finding.Key, observedAt time.Time,
) (finding.Record, bool, error) {
	s.passes++
	existing, found := s.records[key.SubjectID]
	if !found || existing.Status == finding.Resolved {
		return existing, false, nil
	}
	existing.Status = finding.Resolved
	existing.ResolvedAt = observedAt
	s.records[key.SubjectID] = existing
	return existing, true, nil
}

func (s *countingFindings) GetFindingsForSubjects(
	_ context.Context, keys []finding.Key,
) (map[string]finding.Record, error) {
	s.batchGets++
	found := make(map[string]finding.Record, len(keys))
	for _, key := range keys {
		if record, ok := s.records[key.SubjectID]; ok {
			found[key.SubjectID] = record
		}
	}
	return found, nil
}

func (s *countingFindings) TransitionFinding(
	context.Context, finding.Key, finding.Transition,
) (finding.Record, error) {
	panic("not used by evaluation")
}

func (s *countingFindings) GetFinding(
	context.Context, finding.Key,
) (finding.Record, bool, error) {
	panic("not used by evaluation")
}

func (s *countingFindings) ListFindings(
	context.Context, finding.Query,
) ([]finding.Record, error) {
	panic("not used by evaluation")
}

func (s *countingFindings) ListFindingEvents(
	context.Context, finding.Key, int, int,
) ([]finding.Event, error) {
	panic("not used by evaluation")
}

type stubEvaluator struct {
	evaluation rule.Evaluation
}

func (e *stubEvaluator) EvaluateRule(
	context.Context, rule.Record, string, string,
) (rule.Evaluation, error) {
	return e.evaluation, nil
}

type stubRuleStore struct {
	record rule.Record
}

func (s *stubRuleStore) GetRuleVersion(
	_ context.Context, _ string, _ int,
) (rule.Record, bool, error) {
	return s.record, true, nil
}

func (s *stubRuleStore) GetRule(_ context.Context, _ string) (rule.Record, bool, error) {
	return s.record, true, nil
}

func (s *stubRuleStore) SaveRule(_ context.Context, record rule.Record) (rule.Record, error) {
	return record, nil
}

func (s *stubRuleStore) ListRules(context.Context, rule.Query) ([]rule.Record, error) {
	return nil, nil
}

func (s *stubRuleStore) SetRuleStatus(
	_ context.Context, _ string, _ int, _ rule.Status, _ time.Time,
) (rule.Record, error) {
	return s.record, nil
}
func (s *stubRuleStore) DeleteRule(_ context.Context, _ rule.DeleteRequest) (rule.Deletion, error) {
	return rule.Deletion{}, nil
}
func (s *stubRuleStore) SaveRuleExplanation(context.Context, string, int, rule.Explanation) error {
	return nil
}
func (s *stubRuleStore) GetRuleExplanation(
	_ context.Context, _ string, _ int,
) (rule.Explanation, bool, error) {
	return rule.Explanation{}, false, nil
}

func testRule() rule.Record {
	return rule.Record{
		ID: "orders-provisioned", Name: "Orders provisioned",
		Scope: rule.TableScope, SubjectType: "order", Version: 3,
		Status: rule.Enabled, Query: "SELECT 1", MaxRows: 500,
		BaselineAt: time.Unix(0, 0).UTC(),
	}.WithDefaults()
}

func evaluationOf(observations []rule.Observation, at time.Time) rule.Evaluation {
	return rule.Evaluation{Observations: observations, EvaluatedAt: at}
}

func newTestService(
	t *testing.T,
	evaluation rule.Evaluation,
	outcomes ports.SubjectOutcomeStore,
	findings *countingFindings,
) *Service {
	t.Helper()
	service, err := New(
		&stubRuleStore{record: testRule()},
		nil,
		&stubEvaluator{evaluation: evaluation},
		findings,
		outcomes,
		func() time.Time { return evaluation.EvaluatedAt },
	)
	if err != nil {
		t.Fatalf("build service: %v", err)
	}
	return service
}

func passingPage(size int, at time.Time) []rule.Observation {
	observations := make([]rule.Observation, 0, size)
	for index := range size {
		observations = append(observations, rule.Observation{
			SubjectID: "order-" + strconv.Itoa(1000+index),
			Status:    rule.Passed,
			Evidence:  `{"status":"provisioned"}`,
		})
	}
	return observations
}

// A page of healthy subjects must cost a fixed number of statements, not a
// number proportional to the page. This is the regression that made a 40 000
// subject scan take over two minutes and never finish inside its budget.
func TestHealthyPageCostsAFixedNumberOfStatements(t *testing.T) {
	at := time.Date(2026, 8, 4, 12, 0, 0, 0, time.UTC)
	outcomes, findings := newCountingOutcomes(), newCountingFindings()
	service := newTestService(t, evaluationOf(passingPage(500, at), at), outcomes, findings)

	if _, changed, err := service.EvaluateVersion(
		context.Background(), "orders-provisioned", 3, "", "",
	); err != nil || len(changed) != 0 {
		t.Fatalf("a page of passes changes no finding: changed=%d err=%v", len(changed), err)
	}

	if outcomes.singleGets != 0 || outcomes.singleSaves != 0 {
		t.Fatalf("evaluation must not fall back to per-subject storage: %+v", outcomes)
	}
	if outcomes.batchGets != 1 || outcomes.batchSaves != 1 {
		t.Fatalf("a page is one read and one write, got %d reads and %d writes",
			outcomes.batchGets, outcomes.batchSaves)
	}
	if outcomes.largestBatch != 500 {
		t.Fatalf("the whole page must be read at once, got %d", outcomes.largestBatch)
	}
	if findings.batchGets != 1 {
		t.Fatalf("existing findings are read once per page, got %d", findings.batchGets)
	}
	// The point of the batch read: a passing subject that never had a Finding
	// must not open a transaction to discover there is nothing to resolve.
	if findings.passes != 0 {
		t.Fatalf("a pass with no existing finding must not touch the finding store, got %d calls",
			findings.passes)
	}
}

// The optimisation must not lose the behaviour it was built around: a pass
// still resolves a Finding that is actually open.
func TestPassStillResolvesAnOpenFinding(t *testing.T) {
	at := time.Date(2026, 8, 4, 12, 0, 0, 0, time.UTC)
	outcomes, findings := newCountingOutcomes(), newCountingFindings()
	key := finding.Key{
		RuleID: "orders-provisioned", SubjectType: "order",
		SubjectID: "order-1000", ObservedInvariantVersion: 3,
	}
	findings.records["order-1000"] = finding.Record{Key: key, Status: finding.Open}

	service := newTestService(t, evaluationOf(passingPage(3, at), at), outcomes, findings)
	_, changed, err := service.EvaluateVersion(
		context.Background(), "orders-provisioned", 3, "", "",
	)
	if err != nil {
		t.Fatal(err)
	}
	if len(changed) != 1 || changed[0].Status != finding.Resolved {
		t.Fatalf("the open finding must resolve: %+v", changed)
	}
	if findings.passes != 1 {
		t.Fatalf("only the subject with a finding pays for the pass path, got %d", findings.passes)
	}
}

// A Finding that is already resolved must not be re-resolved on every scan.
func TestResolvedFindingIsNotTouchedAgain(t *testing.T) {
	at := time.Date(2026, 8, 4, 12, 0, 0, 0, time.UTC)
	outcomes, findings := newCountingOutcomes(), newCountingFindings()
	key := finding.Key{
		RuleID: "orders-provisioned", SubjectType: "order",
		SubjectID: "order-1000", ObservedInvariantVersion: 3,
	}
	findings.records["order-1000"] = finding.Record{Key: key, Status: finding.Resolved}

	service := newTestService(t, evaluationOf(passingPage(3, at), at), outcomes, findings)
	if _, changed, err := service.EvaluateVersion(
		context.Background(), "orders-provisioned", 3, "", "",
	); err != nil || len(changed) != 0 {
		t.Fatalf("a resolved finding stays resolved silently: changed=%d err=%v", len(changed), err)
	}
	if findings.passes != 0 {
		t.Fatalf("a resolved finding must not be rewritten, got %d calls", findings.passes)
	}
}

// Violations still go through the transactional write path, one per subject.
func TestViolationsOpenFindings(t *testing.T) {
	at := time.Date(2026, 8, 4, 12, 0, 0, 0, time.UTC)
	observations := passingPage(4, at)
	observations[1].Status = rule.Violated
	observations[3].Status = rule.Violated

	outcomes, findings := newCountingOutcomes(), newCountingFindings()
	service := newTestService(t, evaluationOf(observations, at), outcomes, findings)
	_, changed, err := service.EvaluateVersion(
		context.Background(), "orders-provisioned", 3, "", "",
	)
	if err != nil {
		t.Fatal(err)
	}
	if len(changed) != 2 || findings.observes != 2 {
		t.Fatalf("each violation opens one finding: changed=%d observes=%d",
			len(changed), findings.observes)
	}
	if outcomes.batchSaves != 1 {
		t.Fatalf("violations do not split the page write: %d", outcomes.batchSaves)
	}
}

// An unknown is not a pass. With the default retry policy it must not open a
// Finding and must not resolve one either.
func TestUnknownUnderRetryPolicyOpensNothing(t *testing.T) {
	at := time.Date(2026, 8, 4, 12, 0, 0, 0, time.UTC)
	observations := passingPage(2, at)
	observations[0].Status = rule.Unknown
	observations[0].Reason = "provider_timeout"

	outcomes, findings := newCountingOutcomes(), newCountingFindings()
	key := finding.Key{
		RuleID: "orders-provisioned", SubjectType: "order",
		SubjectID: observations[0].SubjectID, ObservedInvariantVersion: 3,
	}
	findings.records[observations[0].SubjectID] = finding.Record{Key: key, Status: finding.Open}

	service := newTestService(t, evaluationOf(observations, at), outcomes, findings)
	if _, changed, err := service.EvaluateVersion(
		context.Background(), "orders-provisioned", 3, "", "",
	); err != nil || len(changed) != 0 {
		t.Fatalf("an unknown neither opens nor resolves: changed=%+v err=%v", changed, err)
	}
	if findings.passes != 0 || findings.observes != 0 {
		t.Fatalf("an unknown must not reach the finding write path: %+v", findings)
	}
	if stored := outcomes.records[observations[0].SubjectID]; stored.Status != rule.Unknown ||
		stored.UnknownCount != 1 || stored.Reason != "provider_timeout" {
		t.Fatalf("the unknown streak must be materialized: %+v", stored)
	}
}

// A page whose write lost to a newer observation must not be projected into a
// Finding. The batch save reports that per subject the same way the single-row
// save reported it with a boolean.
func TestStaleObservationIsNotProjected(t *testing.T) {
	at := time.Date(2026, 8, 4, 12, 0, 0, 0, time.UTC)
	observations := passingPage(2, at)
	observations[0].Status = rule.Violated

	outcomes := &rejectingOutcomes{countingOutcomes: newCountingOutcomes()}
	findings := newCountingFindings()
	service := newTestService(t, evaluationOf(observations, at), outcomes, findings)

	if _, changed, err := service.EvaluateVersion(
		context.Background(), "orders-provisioned", 3, "", "",
	); err != nil || len(changed) != 0 {
		t.Fatalf("a rejected write opens no finding: changed=%d err=%v", len(changed), err)
	}
	if findings.observes != 0 {
		t.Fatalf("a stale violation must not open a finding, got %d", findings.observes)
	}
}

// rejectingOutcomes stands in for a page that lost every row to a newer
// observation, which is what a targeted recheck racing a scan produces.
type rejectingOutcomes struct {
	*countingOutcomes
}

func (s *rejectingOutcomes) SaveSubjectOutcomes(
	_ context.Context, _ []subjectoutcome.Record,
) (map[string]bool, error) {
	s.batchSaves++
	return map[string]bool{}, nil
}

var (
	_ ports.SubjectOutcomeStore = (*countingOutcomes)(nil)
	_ ports.SubjectOutcomeStore = (*rejectingOutcomes)(nil)
	_ ports.FindingStore        = (*countingFindings)(nil)
	_ ports.RuleEvaluator       = (*stubEvaluator)(nil)
	_ ports.RuleStore           = (*stubRuleStore)(nil)
)
