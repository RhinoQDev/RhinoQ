package unit

import (
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/rhinoq/rhinoq/internal/domain/admission"
)

func TestAdmissionReservesCapacityForCriticalWork(t *testing.T) {
	policy := admission.Policy{MaxPending: 100, ReservedCritical: 20, OnOverflow: admission.Reject}

	if _, err := policy.Decide("reports", 79, false); err != nil {
		t.Fatalf("standard work below the shared budget must be accepted: %v", err)
	}
	_, err := policy.Decide("reports", 80, false)
	if !errors.Is(err, admission.ErrOverCapacity) {
		t.Fatalf("standard work must stop at the reserved line, got %v", err)
	}
	if _, err := policy.Decide("reports", 80, true); err != nil {
		t.Fatalf("critical work must be able to use the reserve: %v", err)
	}
	if _, err := policy.Decide("reports", 100, true); !errors.Is(err, admission.ErrOverCapacity) {
		t.Fatalf("critical work must still stop at the full budget, got %v", err)
	}
}

func TestAdmissionDelayModeAcceptsWithBackpressure(t *testing.T) {
	policy := admission.Policy{
		MaxPending: 10, ReservedCritical: 0, OnOverflow: admission.Delay, DelayBy: 90 * time.Second,
	}
	decision, err := policy.Decide("telemetry", 10, false)
	if err != nil {
		t.Fatalf("delay mode must accept the job: %v", err)
	}
	if decision.DeferBy != 90*time.Second {
		t.Fatalf("delay mode must push the earliest run time, got %s", decision.DeferBy)
	}
}

func TestOverCapacityErrorExplainsTheFix(t *testing.T) {
	policy := admission.Policy{MaxPending: 5, OnOverflow: admission.Reject, RetryAfter: 30 * time.Second}
	_, err := policy.Decide("video-transcode", 5, false)
	if err == nil {
		t.Fatal("expected a rejection")
	}
	var overCapacity *admission.OverCapacityError
	if !errors.As(err, &overCapacity) || overCapacity.RetryAfter != 30*time.Second {
		t.Fatalf("producers need a typed error carrying a retry hint: %#v", err)
	}
	message := err.Error()
	for _, part := range []string{
		"RHINOQ_QUEUE_OVER_CAPACITY", "What happened", "Why it matters",
		"What RhinoQ did", "How to fix", "Verify", "video-transcode", "30s",
	} {
		if !strings.Contains(message, part) {
			t.Fatalf("error message is missing %q:\n%s", part, message)
		}
	}
}

func TestAdmissionPolicyRejectsUnusableBudgets(t *testing.T) {
	invalid := []admission.Policy{
		{MaxPending: 0, OnOverflow: admission.Reject},
		{MaxPending: 10, ReservedCritical: 10, OnOverflow: admission.Reject},
		{MaxPending: 10, ReservedCritical: -1, OnOverflow: admission.Reject},
		{MaxPending: 10, OnOverflow: "drop"},
	}
	for _, policy := range invalid {
		if err := policy.Validate(); !errors.Is(err, admission.ErrInvalidPolicy) {
			t.Fatalf("policy %+v must be rejected, got %v", policy, err)
		}
	}
}
