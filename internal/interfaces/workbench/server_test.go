package workbench

import (
	"context"
	"encoding/json"
	"io/fs"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestEmbeddedWorkbenchStaysInsideItsFrontendBudget(t *testing.T) {
	var total int64
	err := fs.WalkDir(assets, "static", func(path string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if entry.IsDir() {
			return nil
		}
		info, err := entry.Info()
		if err != nil {
			return err
		}
		total += info.Size()
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	const budget = 160 << 10
	if total > budget {
		t.Fatalf("embedded Workbench grew beyond %d KiB: %d bytes", budget>>10, total)
	}
}

type testOperator struct{ rechecks int }

func (o *testOperator) Recheck(_ context.Context, subject SubjectRef, ruleID string) (ActionResult, error) {
	o.rechecks++
	return ActionResult{Status: "drift", Detail: ruleID + ":" + subject.ID}, nil
}
func (*testOperator) ProposeRepair(context.Context, RepairProposal) (RepairPlan, error) {
	return RepairPlan{ID: "repair_1", State: "proposed", Version: 1}, nil
}
func (*testOperator) PreviewRepair(context.Context, string) (RepairPlan, error) {
	return RepairPlan{ID: "repair_1", State: "previewed", DryRun: true, Version: 2}, nil
}
func (*testOperator) ApproveRepair(context.Context, string, string, string) (RepairPlan, error) {
	return RepairPlan{ID: "repair_1", State: "approved", Version: 3}, nil
}
func (*testOperator) ExecuteRepair(context.Context, string) (RepairPlan, error) {
	return RepairPlan{ID: "repair_1", State: "succeeded", Version: 5}, nil
}

func TestWorkbenchActionsRequireExplicitOperatorAndSameOrigin(t *testing.T) {
	readOnly, err := NewHandler(NewDemoReader(), Options{})
	if err != nil {
		t.Fatal(err)
	}
	body := strings.NewReader(`{"ruleId":"rule-report-output"}`)
	request := httptest.NewRequest(http.MethodPost, "/api/v1/subjects/report/report_3Q1N/recheck", body)
	request.Host = "127.0.0.1:7070"
	recorder := httptest.NewRecorder()
	readOnly.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusMethodNotAllowed {
		t.Fatalf("read-only action got %d", recorder.Code)
	}

	operator := &testOperator{}
	handler, err := NewHandler(NewDemoReader(), Options{Operator: operator})
	if err != nil {
		t.Fatal(err)
	}
	request = httptest.NewRequest(http.MethodPost, "/api/v1/subjects/report/report_3Q1N/recheck", strings.NewReader(`{"ruleId":"rule-report-output"}`))
	request.Host = "127.0.0.1:7070"
	request.Header.Set("Content-Type", "application/json")
	recorder = httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusOK || operator.rechecks != 1 {
		t.Fatalf("action=%d rechecks=%d body=%s", recorder.Code, operator.rechecks, recorder.Body.String())
	}
}

func TestWorkbenchServesEmbeddedInterfaceWithSecurityHeaders(t *testing.T) {
	handler, err := NewHandler(NewDemoReader(), Options{Version: "test"})
	if err != nil {
		t.Fatal(err)
	}
	request := localRequest(http.MethodGet, "/")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)

	if response.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", response.Code, response.Body.String())
	}
	if !strings.Contains(response.Body.String(), "RhinoQ Workbench") {
		t.Fatal("embedded interface did not contain the product name")
	}
	if value := response.Header().Get("Content-Security-Policy"); !strings.Contains(value, "frame-ancestors 'none'") {
		t.Fatalf("missing strict CSP: %q", value)
	}
	if value := response.Header().Get("X-Frame-Options"); value != "DENY" {
		t.Fatalf("expected frame denial, got %q", value)
	}
}

func TestWorkbenchSnapshotIsBoundedAndPayloadFree(t *testing.T) {
	handler, err := NewHandler(NewDemoReader(), Options{})
	if err != nil {
		t.Fatal(err)
	}
	request := localRequest(http.MethodGet, "/api/v1/snapshot?limit=3&states=succeeded,leased")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)

	if response.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", response.Code, response.Body.String())
	}
	var snapshot Snapshot
	if err := json.Unmarshal(response.Body.Bytes(), &snapshot); err != nil {
		t.Fatal(err)
	}
	if len(snapshot.Jobs) > 3 {
		t.Fatalf("limit was not enforced: %d jobs", len(snapshot.Jobs))
	}
	for _, item := range snapshot.Jobs {
		if item.State != "succeeded" && item.State != "leased" {
			t.Fatalf("unexpected state %q", item.State)
		}
	}
	if strings.Contains(strings.ToLower(response.Body.String()), `"payload"`) {
		t.Fatal("Workbench must not export job payloads")
	}
}

func TestWorkbenchRejectsInvalidFiltersAndCrossOriginRequests(t *testing.T) {
	handler, err := NewHandler(NewDemoReader(), Options{})
	if err != nil {
		t.Fatal(err)
	}
	invalid := localRequest(http.MethodGet, "/api/v1/snapshot?states=imaginary")
	invalidResponse := httptest.NewRecorder()
	handler.ServeHTTP(invalidResponse, invalid)
	if invalidResponse.Code != http.StatusBadRequest {
		t.Fatalf("expected invalid filter rejection, got %d", invalidResponse.Code)
	}

	crossOrigin := localRequest(http.MethodGet, "/api/v1/snapshot")
	crossOrigin.Header.Set("Origin", "https://attacker.example")
	crossOriginResponse := httptest.NewRecorder()
	handler.ServeHTTP(crossOriginResponse, crossOrigin)
	if crossOriginResponse.Code != http.StatusForbidden {
		t.Fatalf("expected cross-origin rejection, got %d", crossOriginResponse.Code)
	}
}

func TestWorkbenchJobDetailSeparatesEffectAndOutcomeEvidence(t *testing.T) {
	handler, err := NewHandler(NewDemoReader(), Options{})
	if err != nil {
		t.Fatal(err)
	}
	request := localRequest(http.MethodGet, "/api/v1/jobs/job_01J0REPORT7D9A")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", response.Code, response.Body.String())
	}
	var detail JobDetail
	if err := json.Unmarshal(response.Body.Bytes(), &detail); err != nil {
		t.Fatal(err)
	}
	if len(detail.Effects) != 1 || detail.Effects[0].State != "confirmed" {
		t.Fatalf("effect evidence was not preserved: %+v", detail.Effects)
	}
	if len(detail.Outcomes) != 1 || detail.Outcomes[0].State != "achieved" {
		t.Fatalf("outcome evidence was not preserved: %+v", detail.Outcomes)
	}
}

func TestWorkbenchRejectsDNSRebindingHost(t *testing.T) {
	handler, err := NewHandler(NewDemoReader(), Options{})
	if err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(http.MethodGet, "http://attacker.example/api/v1/snapshot", nil)
	request.Header.Set("Origin", "http://attacker.example")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusForbidden {
		t.Fatalf("expected non-loopback host rejection, got %d", response.Code)
	}
}

func localRequest(method, target string) *http.Request {
	request := httptest.NewRequest(method, target, nil)
	request.Host = "127.0.0.1:8787"
	return request
}

func TestSubjectDetailServesTheInvestigationView(t *testing.T) {
	handler, err := NewHandler(NewDemoReader(), Options{})
	if err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(http.MethodGet, "/api/v1/subjects/report/report_3Q1N", nil)
	request.Host = "127.0.0.1:7070"
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", recorder.Code, recorder.Body.String())
	}
	var detail SubjectDetail
	if err := json.Unmarshal(recorder.Body.Bytes(), &detail); err != nil {
		t.Fatal(err)
	}
	if detail.Subject.Type != "report" || detail.Subject.ID != "report_3Q1N" {
		t.Fatalf("the response must describe the requested subject: %+v", detail.Subject)
	}
	if len(detail.Findings) == 0 {
		t.Fatal("the demo subject has drift recorded against it")
	}

	// The point of the page: an execution RhinoQ never ran appears next to one
	// it did, on the same subject.
	var external, internal bool
	for _, item := range detail.Executions {
		if item.SourceSystem == "rhinoq" {
			internal = true
		} else {
			external = true
		}
	}
	if !external || !internal {
		t.Fatalf("both a RhinoQ and a non-RhinoQ execution must be visible: %+v", detail.Executions)
	}

	// History must be one ordered narrative, not several lists side by side.
	for index := 1; index < len(detail.History); index++ {
		if detail.History[index].OccurredAt.Before(detail.History[index-1].OccurredAt) {
			t.Fatalf("subject history must be in time order, entry %d goes backwards", index)
		}
	}
	var sawObservation, sawEffect bool
	for _, event := range detail.History {
		switch event.Kind {
		case SubjectEventObservation:
			sawObservation = true
		case SubjectEventEffect:
			sawEffect = true
		}
	}
	if !sawObservation || !sawEffect {
		t.Fatal("the timeline must merge what RhinoQ observed with what executions did")
	}
}

// The summary must never disagree with the lists it summarises, because an
// operator reads the headline and acts on it.
func TestSubjectSummaryReportsUncertainAheadOfDrift(t *testing.T) {
	handler, err := NewHandler(NewDemoReader(), Options{})
	if err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(http.MethodGet, "/api/v1/subjects/report/report_3Q1N", nil)
	request.Host = "127.0.0.1:7070"
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)
	var detail SubjectDetail
	if err := json.Unmarshal(recorder.Body.Bytes(), &detail); err != nil {
		t.Fatal(err)
	}
	open := 0
	for _, item := range detail.Findings {
		switch item.Status {
		case "open", "acknowledged", "repair_proposed", "repairing", "regressed":
			open++
		}
	}
	if detail.Summary.OpenFindings != open {
		t.Fatalf("summary claims %d open findings, list has %d",
			detail.Summary.OpenFindings, open)
	}
	if detail.Summary.State == "" || detail.Summary.Headline == "" {
		t.Fatalf("the summary must state a verdict: %+v", detail.Summary)
	}
}

func TestSubjectDetailRejectsAnIncompleteReference(t *testing.T) {
	handler, err := NewHandler(NewDemoReader(), Options{})
	if err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{
		"/api/v1/subjects/report",
		"/api/v1/subjects/report/",
		"/api/v1/subjects//report_3Q1N",
	} {
		request := httptest.NewRequest(http.MethodGet, path, nil)
		request.Host = "127.0.0.1:7070"
		recorder := httptest.NewRecorder()
		handler.ServeHTTP(recorder, request)
		if recorder.Code != http.StatusBadRequest {
			t.Errorf("%s must be refused, got %d", path, recorder.Code)
		}
	}
}

func TestUnknownSubjectIsNotFound(t *testing.T) {
	handler, err := NewHandler(NewDemoReader(), Options{})
	if err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(http.MethodGet, "/api/v1/subjects/report/nothing_here", nil)
	request.Host = "127.0.0.1:7070"
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusNotFound {
		t.Fatalf("expected 404, got %d", recorder.Code)
	}
}
