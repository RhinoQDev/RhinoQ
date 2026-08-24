package main

import (
	"bytes"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func testNotifySecret(t *testing.T) string {
	t.Helper()
	bytes := make([]byte, 32)
	if _, err := rand.Read(bytes); err != nil {
		t.Fatalf("generate test notification secret: %v", err)
	}
	return hex.EncodeToString(bytes)
}

func notifyEnv(t *testing.T, values map[string]string) func(string) string {
	t.Helper()
	registry := filepath.Join(t.TempDir(), "notifications.json")
	return func(key string) string {
		if key == "RHINOQ_NOTIFY_CONFIG" {
			return registry
		}
		return values[key]
	}
}

// A signed webhook is the one part of RhinoQ that cannot be verified by reading
// code: the secret, the URL, the receiver's signature check and its TLS all
// have to line up at the far end. This exercises exactly that, and the receiver
// verifies the HMAC rather than merely accepting the request.
func TestNotifyTestDeliversASignedEventAReceiverCanVerify(t *testing.T) {
	secret := testNotifySecret(t)
	var body []byte
	var signature, eventID string
	receiver := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ = io.ReadAll(r.Body)
		signature = r.Header.Get("X-RhinoQ-Signature")
		eventID = r.Header.Get("X-RhinoQ-Event-Id")
		w.WriteHeader(http.StatusNoContent)
	}))
	defer receiver.Close()

	getenv := notifyEnv(t, map[string]string{"RHINOQ_NOTIFY_SECRET_OPS": secret})
	var output bytes.Buffer
	if code := runNotifyAdd([]string{
		"ops", "--webhook", receiver.URL, "--secret-env", "RHINOQ_NOTIFY_SECRET_OPS",
	}, getenv, &output); code != 0 {
		t.Fatalf("notify add returned %d: %s", code, output.String())
	}

	output.Reset()
	if code := runNotifyTest([]string{"ops"}, getenv, &output); code != 0 {
		t.Fatalf("notify test returned %d: %s", code, output.String())
	}
	if !strings.Contains(output.String(), "accepted event") {
		t.Fatalf("the receipt should name the event: %s", output.String())
	}

	mac := hmac.New(sha256.New, []byte(secret))
	_, _ = mac.Write(body)
	if expected := "v1=" + hex.EncodeToString(mac.Sum(nil)); signature != expected {
		t.Fatalf("the receiver could not verify the signature:\n got %s\nwant %s", signature, expected)
	}
	var message map[string]any
	if err := json.Unmarshal(body, &message); err != nil {
		t.Fatalf("decode the delivered event: %v", err)
	}
	if message["type"] != "rhinoq.notification.test" {
		t.Fatalf("a probe must be distinguishable from a Finding: %v", message["type"])
	}
	if eventID == "" || message["id"] != eventID {
		t.Fatalf("the event id header and body must agree: header=%q body=%v", eventID, message["id"])
	}
}

// The registry is meant to be safe to leave on disk and even to commit. That is
// only true if the secret genuinely never reaches it.
func TestNotifyRegistryNeverStoresTheSecret(t *testing.T) {
	secret := testNotifySecret(t)
	registryPath := filepath.Join(t.TempDir(), "notifications.json")
	getenv := func(key string) string {
		switch key {
		case "RHINOQ_NOTIFY_CONFIG":
			return registryPath
		case "RHINOQ_NOTIFY_SECRET_OPS":
			return secret
		}
		return ""
	}
	var output bytes.Buffer
	if code := runNotifyAdd([]string{
		"ops", "--webhook", "https://example.com/hooks/rhinoq",
		"--secret-env", "RHINOQ_NOTIFY_SECRET_OPS",
	}, getenv, &output); code != 0 {
		t.Fatalf("notify add returned %d: %s", code, output.String())
	}
	stored, err := os.ReadFile(registryPath)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(stored), secret) {
		t.Fatalf("the registry file holds the secret:\n%s", stored)
	}
	if !strings.Contains(string(stored), "RHINOQ_NOTIFY_SECRET_OPS") {
		t.Fatalf("the registry must record where to read the secret:\n%s", stored)
	}
}

// Sending unsigned from a destination configured to be signed would quietly
// weaken it, which is worse than not sending at all.
func TestNotifyTestRefusesWhenTheConfiguredSecretIsMissing(t *testing.T) {
	getenv := notifyEnv(t, nil)
	var output bytes.Buffer
	if code := runNotifyAdd([]string{
		"ops", "--webhook", "https://example.com/hooks/rhinoq",
		"--secret-env", "RHINOQ_NOTIFY_SECRET_OPS",
	}, getenv, &output); code != 0 {
		t.Fatalf("notify add returned %d: %s", code, output.String())
	}
	output.Reset()
	if code := runNotifyTest([]string{"ops"}, getenv, &output); code != 1 {
		t.Fatalf("expected a refusal, got %d: %s", code, output.String())
	}
	if !strings.Contains(output.String(), "RHINOQ_NOTIFY_SECRET_OPS is empty") {
		t.Fatalf("the failure must name the variable to set: %s", output.String())
	}
}

func TestNotifyAddRejectsPlaintextHTTPToARemoteHost(t *testing.T) {
	getenv := notifyEnv(t, nil)
	var output bytes.Buffer
	code := runNotifyAdd([]string{"ops", "--webhook", "http://example.com/hooks"}, getenv, &output)
	if code != 2 || !strings.Contains(output.String(), "must use HTTPS") {
		t.Fatalf("unexpected result: code=%d output=%s", code, output.String())
	}
}

func TestNotifyRoutingFiltersSeverityRuleAndSubject(t *testing.T) {
	entries := []notifyDestination{
		{Name: "all"},
		{Name: "critical", MinimumSeverity: "critical"},
		{Name: "payments", MinimumSeverity: "high", RuleIDs: []string{"refund-confirmed"}, SubjectTypes: []string{"payment"}},
	}
	routed := routeNotifyEntries(entries, "high", "refund-confirmed", "payment")
	if len(routed) != 2 || routed[0].Name != "all" || routed[1].Name != "payments" {
		t.Fatalf("unexpected high routes: %#v", routed)
	}
	routed = routeNotifyEntries(entries, "medium", "refund-confirmed", "payment")
	if len(routed) != 1 || routed[0].Name != "all" {
		t.Fatalf("unexpected medium routes: %#v", routed)
	}
}

func TestNotifyAddPersistsRoutingWithoutSecrets(t *testing.T) {
	getenv := notifyEnv(t, nil)
	var output bytes.Buffer
	if code := runNotifyAdd([]string{
		"ops", "--webhook", "https://example.com/hooks/rhinoq",
		"--minimum-severity", "high", "--rule", "refund-confirmed", "--subject-type", "payment",
	}, getenv, &output); code != 0 {
		t.Fatalf("notify add returned %d: %s", code, output.String())
	}
	registry, err := loadNotifyRegistry(notifyRegistryPath(getenv))
	if err != nil {
		t.Fatal(err)
	}
	entry := registry.Destinations[0]
	if entry.MinimumSeverity != "high" || len(entry.RuleIDs) != 1 || entry.RuleIDs[0] != "refund-confirmed" || len(entry.SubjectTypes) != 1 || entry.SubjectTypes[0] != "payment" {
		t.Fatalf("routing fields were not preserved: %#v", entry)
	}
}

func TestNotifyAddWarnsAboutAnUnsignedWebhook(t *testing.T) {
	getenv := notifyEnv(t, nil)
	var output bytes.Buffer
	if code := runNotifyAdd([]string{"ops", "--webhook", "https://example.com/hooks"}, getenv, &output); code != 0 {
		t.Fatalf("notify add returned %d: %s", code, output.String())
	}
	if !strings.Contains(output.String(), "sent unsigned") {
		t.Fatalf("an unsigned webhook must be called out: %s", output.String())
	}
}

// A Slack incoming webhook URL is a bearer credential. Listing destinations is
// something an operator does in a shared terminal.
func TestNotifyListRedactsTheEndpointAndReportsSecretReadiness(t *testing.T) {
	getenv := notifyEnv(t, map[string]string{"RHINOQ_NOTIFY_SECRET_OPS": "value"})
	var output bytes.Buffer
	if code := runNotifyAdd([]string{
		"ops", "--slack", "https://hooks.slack.com/services/T000/B000/XXXXSECRETXXXX",
		"--secret-env", "RHINOQ_NOTIFY_SECRET_OPS",
	}, getenv, &output); code != 0 {
		t.Fatalf("notify add returned %d: %s", code, output.String())
	}
	if code := runNotifyAdd([]string{
		"pager", "--webhook", "https://example.com/hooks/rhinoq",
		"--secret-env", "RHINOQ_NOTIFY_SECRET_PAGER",
	}, getenv, &output); code != 0 {
		t.Fatalf("notify add returned %d: %s", code, output.String())
	}

	output.Reset()
	if code := runNotifyList(nil, getenv, &output); code != 0 {
		t.Fatalf("notify list returned %d: %s", code, output.String())
	}
	listing := output.String()
	if strings.Contains(listing, "XXXXSECRETXXXX") {
		t.Fatalf("the Slack credential was printed in full: %s", listing)
	}
	if !strings.Contains(listing, "hooks.slack.com") {
		t.Fatalf("a redacted endpoint must still be recognisable: %s", listing)
	}
	if !strings.Contains(listing, "$RHINOQ_NOTIFY_SECRET_PAGER is empty") {
		t.Fatalf("an unusable destination must say so before an incident does: %s", listing)
	}
}

func TestNotifyAddRefusesToOverwriteWithoutReplace(t *testing.T) {
	getenv := notifyEnv(t, nil)
	var output bytes.Buffer
	args := []string{"ops", "--webhook", "https://example.com/a", "--secret-env", "S"}
	if code := runNotifyAdd(args, getenv, &output); code != 0 {
		t.Fatalf("first add returned %d: %s", code, output.String())
	}
	output.Reset()
	if code := runNotifyAdd(args, getenv, &output); code != 1 {
		t.Fatalf("expected a refusal, got %d: %s", code, output.String())
	}
	if !strings.Contains(output.String(), "--replace") {
		t.Fatalf("the refusal must name the way forward: %s", output.String())
	}
}

func TestNotifyRemoveReportsAnUnknownDestination(t *testing.T) {
	getenv := notifyEnv(t, nil)
	var output bytes.Buffer
	if code := runNotifyRemove([]string{"missing"}, getenv, &output); code != 1 {
		t.Fatalf("expected a failure, got %d: %s", code, output.String())
	}
}
