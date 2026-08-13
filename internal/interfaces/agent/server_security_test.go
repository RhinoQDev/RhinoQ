package agent

import (
	"bytes"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/madebyduy/RhinoQ/pkg/rhinoq"
)

const securityTestToken = "security-test-token-at-least-32-bytes"

func TestNewRejectsShortAgentToken(t *testing.T) {
	_, err := New(Config{Client: rhinoq.NewInMemory(), Token: "short"})
	if err == nil {
		t.Fatal("short bearer tokens must be rejected")
	}
}

func TestNewRejectsTaskCredentialPrivilegeCollisions(t *testing.T) {
	_, err := New(Config{
		Client: rhinoq.NewInMemory(),
		Token:  securityTestToken,
		TaskCredentials: []TaskCredential{{
			OwnerID: "tenant-a", Token: securityTestToken,
		}},
	})
	if err == nil {
		t.Fatal("owner credential must not equal the operator token")
	}
	shared := "shared-owner-token-at-least-thirty-two-bytes"
	_, err = New(Config{
		Client: rhinoq.NewInMemory(),
		Token:  securityTestToken,
		TaskCredentials: []TaskCredential{
			{OwnerID: "tenant-a", Token: shared},
			{OwnerID: "tenant-b", Token: shared},
		},
	})
	if err == nil {
		t.Fatal("one owner token must not authorize multiple owners")
	}
}

func TestNewRejectsTaskCredentialFromAnotherTenant(t *testing.T) {
	_, err := New(Config{
		Client: rhinoq.NewInMemory(), Token: securityTestToken, TenantID: "tenant-a",
		TaskCredentials: []TaskCredential{{
			TenantID: "tenant-b", OwnerID: "owner-1",
			Token: "owner-token-that-is-at-least-thirty-two-bytes",
		}},
	})
	if err == nil || !strings.Contains(err.Error(), "must match") {
		t.Fatalf("cross-tenant credential must be rejected at startup: %v", err)
	}
}

func TestAgentRoleDeniesMutationAndAllowsRead(t *testing.T) {
	server, err := New(Config{Client: rhinoq.NewInMemory(), Token: securityTestToken, TenantID: "tenant-a", Role: "viewer"})
	if err != nil {
		t.Fatal(err)
	}

	read := httptest.NewRequest(http.MethodGet, "/v1/jobs?limit=1", nil)
	read.Header.Set("Authorization", "Bearer "+securityTestToken)
	readResponse := httptest.NewRecorder()
	server.ServeHTTP(readResponse, read)
	if readResponse.Code == http.StatusForbidden {
		t.Fatalf("viewer read was denied: %s", readResponse.Body.String())
	}

	mutation := httptest.NewRequest(http.MethodPost, "/v1/queues/reports/pause", nil)
	mutation.Header.Set("Authorization", "Bearer "+securityTestToken)
	mutationResponse := httptest.NewRecorder()
	server.ServeHTTP(mutationResponse, mutation)
	if mutationResponse.Code != http.StatusForbidden || !strings.Contains(mutationResponse.Body.String(), "queue:operate") {
		t.Fatalf("viewer queue mutation was not role-denied: %d %s", mutationResponse.Code, mutationResponse.Body.String())
	}
}

func TestNewRejectsUnknownAgentRole(t *testing.T) {
	_, err := New(Config{Client: rhinoq.NewInMemory(), Token: securityTestToken, Role: "superuser"})
	if err == nil {
		t.Fatal("unknown Agent role must fail startup")
	}
}

func TestDecodeRejectsTrailingJSON(t *testing.T) {
	server, err := New(Config{
		Client: rhinoq.NewInMemory(),
		Token:  securityTestToken,
	})
	if err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(
		http.MethodPost,
		"/v1/tasks",
		bytes.NewBufferString(`{"id":"task-1","type":"export","definitionVersion":1}{"id":"task-2"}`),
	)
	request.Header.Set("Authorization", "Bearer "+securityTestToken)
	response := httptest.NewRecorder()

	server.ServeHTTP(response, request)

	if response.Code != http.StatusBadRequest ||
		!strings.Contains(response.Body.String(), "exactly one JSON value") {
		t.Fatalf("trailing JSON must be rejected: %d %s", response.Code, response.Body.String())
	}
}

func TestInvalidJSONDoesNotEchoParserDetails(t *testing.T) {
	server, err := New(Config{
		Client: rhinoq.NewInMemory(),
		Token:  securityTestToken,
	})
	if err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(
		http.MethodPost,
		"/v1/tasks",
		bytes.NewBufferString(`{"ownerId":"do-not-reflect-this-secret"`),
	)
	request.Header.Set("Authorization", "Bearer "+securityTestToken)
	response := httptest.NewRecorder()

	server.ServeHTTP(response, request)

	if response.Code != http.StatusBadRequest {
		t.Fatalf("invalid JSON should be rejected: %d", response.Code)
	}
	if strings.Contains(response.Body.String(), "do-not-reflect-this-secret") {
		t.Fatalf("request data leaked into the error response: %s", response.Body.String())
	}
}

func TestAuthenticatedRoutesFailFastAtTheProcessRateLimit(t *testing.T) {
	server, err := New(Config{Client: rhinoq.NewInMemory(), Token: securityTestToken,
		RequestsPerSecond: 0.01, RequestBurst: 1})
	if err != nil {
		t.Fatal(err)
	}
	for attempt := 0; attempt < 2; attempt++ {
		request := httptest.NewRequest(http.MethodGet, "/metrics", nil)
		request.Header.Set("Authorization", "Bearer "+securityTestToken)
		response := httptest.NewRecorder()
		server.ServeHTTP(response, request)
		if attempt == 0 && response.Code != http.StatusOK {
			t.Fatalf("first=%d", response.Code)
		}
		if attempt == 1 && (response.Code != http.StatusTooManyRequests || response.Header().Get("Retry-After") == "") {
			t.Fatalf("second=%d retry=%q body=%s", response.Code, response.Header().Get("Retry-After"), response.Body.String())
		}
	}
}
