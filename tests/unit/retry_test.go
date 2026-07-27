package unit

import (
	"testing"
	"time"

	"github.com/rhinoq/rhinoq/internal/domain/retry"
)

func TestRetryPolicyClassifiesFailures(t *testing.T) {
	now := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	policy := retry.Policy{MaxAttempts: 5, BaseDelay: time.Second, MaxDelay: 10 * time.Second}

	transient := policy.Decide(retry.Transient, 2, now, 0)
	if !transient.Retry || !transient.NextRunAt.Equal(now.Add(2*time.Second)) {
		t.Fatalf("unexpected transient decision: %+v", transient)
	}

	permanent := policy.Decide(retry.Permanent, 1, now, 0)
	if !permanent.Dead || permanent.Retry {
		t.Fatalf("permanent error must be dead: %+v", permanent)
	}

	// An unclassified error gets a small number of cautious retries and is then
	// parked for a decision rather than retried into a storm.
	unknown := policy.Decide(retry.Unknown, 1, now, 0)
	if !unknown.Retry || unknown.Blocked {
		t.Fatalf("first unknown error should be retried cautiously: %+v", unknown)
	}
	exhausted := policy.Decide(retry.Unknown, retry.UnknownMaxAttempts, now, 0)
	if !exhausted.Blocked || exhausted.Retry {
		t.Fatalf("unknown error must be blocked once its cautious retries run out: %+v", exhausted)
	}

	rateLimited := policy.Decide(retry.RateLimited, 1, now, 30*time.Second)
	if !rateLimited.Retry || !rateLimited.NextRunAt.Equal(now.Add(30*time.Second)) {
		t.Fatalf("provider retry-after must be respected: %+v", rateLimited)
	}
}

func TestRetryPolicyAppliesBoundedJitter(t *testing.T) {
	now := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	policy := retry.Policy{
		MaxAttempts: 5,
		BaseDelay:   time.Second,
		MaxDelay:    10 * time.Second,
		Jitter:      0.5,
		Random:      func() float64 { return 1 },
	}

	decision := policy.Decide(retry.Transient, 3, now, 0)
	if !decision.NextRunAt.Equal(now.Add(2 * time.Second)) {
		t.Fatalf("expected 50%% jitter on four-second delay, got %s", decision.NextRunAt.Sub(now))
	}
}
