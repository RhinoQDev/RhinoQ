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
