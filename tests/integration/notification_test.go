package integration_test

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/madebyduy/RhinoQ/pkg/rhinoq"
)

func TestFindingWebhookIsSignedAndEvidenceIsOptIn(t *testing.T) {
	var body []byte
	var signature, eventID string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ = io.ReadAll(r.Body)
		signature = r.Header.Get("X-RhinoQ-Signature")
		eventID = r.Header.Get("X-RhinoQ-Event-Id")
		w.WriteHeader(http.StatusNoContent)
	}))
	defer server.Close()
	client := rhinoq.NewInMemory()
	key := rhinoq.FindingKey{RuleID: "r", SubjectType: "invoice", SubjectID: "7", InvariantVersion: 1}
	_, err := client.ObserveFinding(context.Background(), rhinoq.FindingObservation{FindingKey: key, Evidence: "secret-account-value", ObservedAt: time.Now().UTC()})
	if err != nil {
		t.Fatal(err)
	}
	receipt, err := client.SendFindingNotification(context.Background(), key, rhinoq.NotificationDestination{URL: server.URL, Kind: "webhook", Secret: "shared"})
	if err != nil {
		t.Fatal(err)
	}
	if receipt.ID == "" || receipt.ID != eventID {
		t.Fatalf("event id mismatch: %+v header=%q", receipt, eventID)
	}
	if string(body) == "" || contains(string(body), "secret-account-value") {
		t.Fatalf("evidence leaked by default: %s", body)
	}
	mac := hmac.New(sha256.New, []byte("shared"))
	_, _ = mac.Write(body)
	want := "v1=" + hex.EncodeToString(mac.Sum(nil))
	if !hmac.Equal([]byte(signature), []byte(want)) {
		t.Fatalf("bad signature %q", signature)
	}
}

func TestFindingSlackPayloadUsesBlocks(t *testing.T) {
	var body []byte
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ = io.ReadAll(r.Body)
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()
	client := rhinoq.NewInMemory()
	key := rhinoq.FindingKey{RuleID: "slack-rule", SubjectType: "report", SubjectID: "9", InvariantVersion: 1}
	_, err := client.ObserveFinding(context.Background(), rhinoq.FindingObservation{FindingKey: key, Evidence: "missing output", ObservedAt: time.Now().UTC()})
	if err != nil {
		t.Fatal(err)
	}
	_, err = client.SendFindingNotification(context.Background(), key, rhinoq.NotificationDestination{URL: server.URL, Kind: "slack", IncludeEvidence: true})
	if err != nil {
		t.Fatal(err)
	}
	if !contains(string(body), `"blocks"`) || !contains(string(body), "missing output") {
		t.Fatalf("invalid Slack payload: %s", body)
	}
}

func TestFindingNotificationDeduplicatesPerDestinationAndHonorsGrace(t *testing.T) {
	calls := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		w.WriteHeader(http.StatusNoContent)
	}))
	defer server.Close()
	client := rhinoq.NewInMemory()
	key := rhinoq.FindingKey{RuleID: "dedup-rule", SubjectType: "order", SubjectID: "42", InvariantVersion: 1}
	now := time.Now().UTC()
	if _, err := client.ObserveFinding(context.Background(), rhinoq.FindingObservation{FindingKey: key, ObservedAt: now}); err != nil {
		t.Fatal(err)
	}
	deferred, err := client.SendFindingNotification(context.Background(), key, rhinoq.NotificationDestination{URL: server.URL, Kind: "webhook", Secret: "secret", GracePeriod: time.Hour})
	if err != nil || deferred.Status != "deferred" || calls != 0 {
		t.Fatalf("deferred=%+v calls=%d err=%v", deferred, calls, err)
	}
	first, err := client.SendFindingNotification(context.Background(), key, rhinoq.NotificationDestination{URL: server.URL, Kind: "webhook", Secret: "secret"})
	if err != nil || first.Status != "sent" || calls != 1 {
		t.Fatalf("first=%+v calls=%d err=%v", first, calls, err)
	}
	repeat, err := client.SendFindingNotification(context.Background(), key, rhinoq.NotificationDestination{URL: server.URL, Kind: "webhook", Secret: "secret"})
	if err != nil || repeat.Status != "deduplicated" || calls != 1 {
		t.Fatalf("repeat=%+v calls=%d err=%v", repeat, calls, err)
	}
	secondDestination := server.URL + "/secondary"
	other, err := client.SendFindingNotification(context.Background(), key, rhinoq.NotificationDestination{URL: secondDestination, Kind: "webhook", Secret: "secret"})
	if err != nil || other.Status != "sent" || calls != 2 {
		t.Fatalf("other=%+v calls=%d err=%v", other, calls, err)
	}
}
func contains(value, part string) bool {
	for i := 0; i+len(part) <= len(value); i++ {
		if value[i:i+len(part)] == part {
			return true
		}
	}
	return false
}
