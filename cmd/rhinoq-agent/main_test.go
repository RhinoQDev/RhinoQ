package main

import (
	"database/sql"
	"testing"
)

func TestOfficialGatewayRegistersPGX(t *testing.T) {
	for _, driver := range sql.Drivers() {
		if driver == "pgx" {
			return
		}
	}
	t.Fatalf("official Gateway must register pgx; available drivers: %v", sql.Drivers())
}

func TestUnauthenticatedAgentMustStayOnLoopback(t *testing.T) {
	for _, address := range []string{"127.0.0.1:8080", "[::1]:8080", "localhost:8080"} {
		if err := validateAgentAddress(address, true); err != nil {
			t.Fatalf("loopback address %q should be accepted: %v", address, err)
		}
	}
	for _, address := range []string{":8080", "0.0.0.0:8080", "[::]:8080", "example.com:8080"} {
		if err := validateAgentAddress(address, true); err == nil {
			t.Fatalf("non-loopback address %q must be rejected without authentication", address)
		}
	}
}

func TestTaskCredentialsParseFromJSONWithoutLoggingSecrets(t *testing.T) {
	t.Setenv("RHINOQ_TASK_CREDENTIALS_JSON", `[
		{"ownerId":"tenant-a","token":"owner-a-token-at-least-thirty-two-bytes"}
	]`)
	credentials, err := taskCredentialsFromEnv()
	if err != nil {
		t.Fatal(err)
	}
	if len(credentials) != 1 || credentials[0].OwnerID != "tenant-a" ||
		credentials[0].Token == "" {
		t.Fatalf("unexpected task credentials: count=%d owner=%q", len(credentials), credentials[0].OwnerID)
	}
	t.Setenv("RHINOQ_TASK_CREDENTIALS_JSON", `not-json`)
	if _, err := taskCredentialsFromEnv(); err == nil {
		t.Fatal("invalid credential JSON must fail startup")
	}
}
