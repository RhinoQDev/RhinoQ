package outbox

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/madebyduy/RhinoQ/internal/ports"
)

func TestHTTPPublisherSignsExactBodyAndKeepsStableEventIdentity(t *testing.T) {
	secret := "test-secret"
	var received []byte
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		received, _ = io.ReadAll(r.Body)
		mac := hmac.New(sha256.New, []byte(secret))
		_, _ = mac.Write(received)
		if r.Header.Get("X-RhinoQ-Signature") != "v1="+hex.EncodeToString(mac.Sum(nil)) || r.Header.Get("X-RhinoQ-Event-Id") != "41" {
			t.Error("missing stable identity or valid signature")
		}
		w.WriteHeader(http.StatusNoContent)
	}))
	defer server.Close()
	publisher, err := NewHTTPPublisher(HTTPPublisherConfig{URL: server.URL, Secret: secret})
	if err != nil {
		t.Fatal(err)
	}
	event := ports.OutboxEvent{ID: 41, EventType: "task.retry.dispatch_requested", Payload: []byte(`{"executionId":"exec-1"}`)}
	if err := publisher.Publish(context.Background(), event); err != nil {
		t.Fatal(err)
	}
	if len(received) == 0 {
		t.Fatal("endpoint received no body")
	}
}

func TestHTTPPublisherFailsClosed(t *testing.T) {
	if _, err := NewHTTPPublisher(HTTPPublisherConfig{URL: "https://example.com", Secret: ""}); err == nil {
		t.Fatal("missing secret must fail")
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { http.Error(w, "no", http.StatusConflict) }))
	defer server.Close()
	publisher, err := NewHTTPPublisher(HTTPPublisherConfig{URL: server.URL, Secret: "secret"})
	if err != nil {
		t.Fatal(err)
	}
	if err := publisher.Publish(context.Background(), ports.OutboxEvent{ID: 1, EventType: "task.retry.dispatch_requested", Payload: []byte(`{}`)}); err == nil {
		t.Fatal("non-2xx must stay unpublished")
	}
}
