package workbench

import (
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
