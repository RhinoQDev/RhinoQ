package unit_test

import (
	"encoding/json"
	"testing"
	"time"

	"github.com/madebyduy/RhinoQ/pkg/rhinoq"
)

// The failure envelope carries a duration across a language boundary. Every
// SDK sends retryAfterMs, so the Go type must read and write milliseconds no
// matter who is holding it; a nanosecond leak here delays a rate-limited retry
// by a factor of a million while every log line still looks correct.
func TestFailureReportUsesMillisecondsOnTheWire(t *testing.T) {
	encoded, err := json.Marshal(rhinoq.FailureReport{
		Type: "RateLimitError", RetryClass: rhinoq.RetryRateLimited,
		Message: "provider asked for backoff", Language: "node",
		RetryAfter: 90 * time.Second,
	})
	if err != nil {
		t.Fatalf("marshal failure report: %v", err)
	}
	var wire map[string]any
	if err := json.Unmarshal(encoded, &wire); err != nil {
		t.Fatalf("decode failure report JSON: %v", err)
	}
	if wire["retryAfterMs"] != float64(90_000) {
		t.Fatalf("retryAfterMs must be milliseconds, got %v in %s", wire["retryAfterMs"], encoded)
	}

	var decoded rhinoq.FailureReport
	if err := json.Unmarshal(encoded, &decoded); err != nil {
		t.Fatalf("unmarshal failure report: %v", err)
	}
	if decoded.RetryAfter != 90*time.Second {
		t.Fatalf("round trip changed the duration: %s", decoded.RetryAfter)
	}
}

// An SDK that misspells a field must be told, not silently given a zero value.
func TestFailureReportRejectsUnknownAndNegativeFields(t *testing.T) {
	var report rhinoq.FailureReport
	if err := json.Unmarshal([]byte(`{"retryClass":"rate_limited","retryAfter":5000}`), &report); err == nil {
		t.Fatal("a misspelled retryAfter field must be rejected, not ignored")
	}
	if err := json.Unmarshal([]byte(`{"retryClass":"rate_limited","retryAfterMs":-1}`), &report); err == nil {
		t.Fatal("a negative backoff must be rejected")
	}
}
