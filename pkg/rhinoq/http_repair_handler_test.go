package rhinoq

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestHTTPRepairHandlerSignsAndSeparatesActions(t *testing.T) {
	const secret = "repair-test-secret-at-least-32-bytes"
	var actions []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		mac := hmac.New(sha256.New, []byte(secret))
		_, _ = mac.Write(body)
		want := "v1=" + hex.EncodeToString(mac.Sum(nil))
		if !hmac.Equal([]byte(r.Header.Get("X-RhinoQ-Repair-Signature")), []byte(want)) {
			t.Error("callback signature mismatch")
		}
		var request repairCallbackRequest
		if err := json.Unmarshal(body, &request); err != nil {
			t.Error(err)
		}
		actions = append(actions, request.Action)
		switch request.Action {
		case "preview":
			_, _ = io.WriteString(w, `{"Summary":"safe plan","Precondition":"order:v1"}`)
		case "apply":
			if request.IdempotencyKey != "repair_1" || r.Header.Get("Idempotency-Key") != "repair_1" {
				t.Error("apply idempotency key missing")
			}
			_, _ = io.WriteString(w, `{"Outcome":"updated once"}`)
		case "verify":
			_, _ = io.WriteString(w, `{"Passed":true,"Evidence":"readback passed"}`)
		}
	}))
	defer server.Close()
	handler, err := NewHTTPRepairHandler(HTTPRepairHandlerOptions{URL: server.URL, Secret: secret})
	if err != nil {
		t.Fatal(err)
	}
	key := FindingKey{RuleID: "rule", SubjectType: "order", SubjectID: "42", InvariantVersion: 1}
	if preview, err := handler.Preview(context.Background(), key, json.RawMessage(`{"orderId":"42"}`)); err != nil || preview.Precondition != "order:v1" {
		t.Fatalf("preview=%+v err=%v", preview, err)
	}
	if applied, err := handler.Apply(context.Background(), key, nil, "repair_1"); err != nil || applied.Outcome != "updated once" {
		t.Fatalf("apply=%+v err=%v", applied, err)
	}
	if verified, err := handler.Verify(context.Background(), key, nil); err != nil || !verified.Passed {
		t.Fatalf("verify=%+v err=%v", verified, err)
	}
	if strings.Join(actions, ",") != "preview,apply,verify" {
		t.Fatalf("actions=%v", actions)
	}
}

func TestHTTPRepairHandlerRejectsUnsafeConfigurationAndOversizedResponse(t *testing.T) {
	if _, err := NewHTTPRepairHandler(HTTPRepairHandlerOptions{URL: "http://example.com/repair", Secret: strings.Repeat("s", 32)}); err == nil {
		t.Fatal("plain HTTP outside loopback accepted")
	}
	if _, err := NewHTTPRepairHandler(HTTPRepairHandlerOptions{URL: "https://example.com/repair", Secret: "short"}); err == nil {
		t.Fatal("short callback secret accepted")
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = io.WriteString(w, strings.Repeat("x", maxRepairCallbackResponse+1))
	}))
	defer server.Close()
	handler, err := NewHTTPRepairHandler(HTTPRepairHandlerOptions{URL: server.URL, Secret: strings.Repeat("s", 32)})
	if err != nil {
		t.Fatal(err)
	}
	_, err = handler.Preview(context.Background(), FindingKey{RuleID: "r", SubjectType: "o", SubjectID: "1", InvariantVersion: 1}, nil)
	if err == nil || !strings.Contains(err.Error(), "64 KiB") {
		t.Fatalf("oversized response err=%v", err)
	}
}
