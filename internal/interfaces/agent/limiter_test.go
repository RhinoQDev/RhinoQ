package agent

import (
	"testing"
	"time"
)

var epoch = time.Date(2026, 8, 17, 12, 0, 0, 0, time.UTC)

// The finding this replaces: one caller could spend the whole process budget
// and every other caller got 429 for traffic that was not theirs.
func TestOneNoisyCallerDoesNotStarveAnother(t *testing.T) {
	limiter := newRequestLimiter(1000, 1000, 10, 10)

	for attempt := 0; attempt < 10; attempt++ {
		if ok, _, _ := limiter.Allow("owner:noisy", epoch); !ok {
			t.Fatalf("noisy caller must get its own budget, refused at attempt %d", attempt)
		}
	}
	if ok, _, scope := limiter.Allow("owner:noisy", epoch); ok || scope != scopeCaller {
		t.Fatalf("noisy caller must be stopped by its own budget: ok=%v scope=%q", ok, scope)
	}

	if ok, _, _ := limiter.Allow("owner:quiet", epoch); !ok {
		t.Fatal("a quiet caller must still be served while another caller is throttled")
	}
}

// Hitting the process ceiling is an operator problem, and the response has to
// say so — telling the caller to slow down would be advice that cannot work.
func TestGatewayCeilingIsReportedSeparately(t *testing.T) {
	limiter := newRequestLimiter(2, 2, 1000, 1000)

	for attempt := 0; attempt < 2; attempt++ {
		if ok, _, _ := limiter.Allow("owner:a", epoch); !ok {
			t.Fatalf("gateway burst of 2 must admit 2 requests, refused at %d", attempt)
		}
	}
	ok, retry, scope := limiter.Allow("owner:b", epoch)
	if ok {
		t.Fatal("the gateway ceiling must still stop the process as a whole")
	}
	if scope != scopeGateway {
		t.Fatalf("scope = %q, want %q so the message names the right limit", scope, scopeGateway)
	}
	if retry <= 0 {
		t.Fatal("a refusal must advertise when to retry")
	}
}

// A caller stopped by the ceiling must not also be charged for it, or it keeps
// paying for a queue it never entered.
func TestCallerIsRefundedWhenTheGatewayRefuses(t *testing.T) {
	limiter := newRequestLimiter(1, 1, 1000, 5)

	if ok, _, _ := limiter.Allow("owner:a", epoch); !ok {
		t.Fatal("first request must pass")
	}
	if ok, _, scope := limiter.Allow("owner:a", epoch); ok || scope != scopeGateway {
		t.Fatalf("second request must be stopped by the gateway: ok=%v scope=%q", ok, scope)
	}

	// One second later the gateway has a token again. The caller must still
	// have four of its five, not three.
	later := epoch.Add(time.Second)
	for attempt := 0; attempt < 1; attempt++ {
		if ok, _, _ := limiter.Allow("owner:a", later); !ok {
			t.Fatal("the caller's budget must not have been spent on a refused request")
		}
	}
}

func TestTokensRefillOverTime(t *testing.T) {
	limiter := newRequestLimiter(1000, 1000, 2, 2)
	for attempt := 0; attempt < 2; attempt++ {
		if ok, _, _ := limiter.Allow("owner:a", epoch); !ok {
			t.Fatalf("burst of 2 must admit 2, refused at %d", attempt)
		}
	}
	if ok, _, _ := limiter.Allow("owner:a", epoch); ok {
		t.Fatal("a third immediate request must be refused")
	}
	if ok, _, _ := limiter.Allow("owner:a", epoch.Add(time.Second)); !ok {
		t.Fatal("two per second means a token exists one second later")
	}
}

// A single-credential Gateway must behave exactly as it did before the split,
// or this becomes a throughput regression dressed up as a fairness fix.
func TestSingleCallerKeepsTheWholeBudget(t *testing.T) {
	if share := fairCallerShare(200, 1, 10); share != 200 {
		t.Fatalf("one caller must keep the full budget, got %v", share)
	}
}

func TestSeveralCallersSplitTheBudget(t *testing.T) {
	if share := fairCallerShare(200, 4, 10); share != 50 {
		t.Fatalf("four callers must split 200 into 50 each, got %v", share)
	}
}

// A share so small that one page load exceeds it is a worse failure than the
// unfairness it prevents.
func TestTheShareHasAFloor(t *testing.T) {
	if share := fairCallerShare(20, 40, 10); share != 10 {
		t.Fatalf("the share must not fall below its floor, got %v", share)
	}
}

func TestOperatorAndOwnerDrawFromDifferentBuckets(t *testing.T) {
	limiter := newRequestLimiter(1000, 1000, 1, 1)

	if ok, _, _ := limiter.Allow("operator", epoch); !ok {
		t.Fatal("operator must get its own budget")
	}
	if ok, _, _ := limiter.Allow("operator", epoch); ok {
		t.Fatal("operator budget must be exhausted after one request")
	}
	if ok, _, _ := limiter.Allow("owner:a", epoch); !ok {
		t.Fatal("an owner must not be limited by operator traffic")
	}
}

// The key comes from the authenticated principal, so a caller cannot move
// itself into a fresh bucket by changing its request.
func TestLimiterKeyComesFromThePrincipal(t *testing.T) {
	for name, expectation := range map[string]struct {
		principal taskPrincipal
		key       string
	}{
		"operator":    {taskPrincipal{operator: true, ownerID: "ignored"}, "operator"},
		"owner":       {taskPrincipal{ownerID: "acme"}, "owner:acme"},
		"no identity": {taskPrincipal{}, "anonymous"},
	} {
		t.Run(name, func(t *testing.T) {
			if got := expectation.principal.limiterKey(); got != expectation.key {
				t.Fatalf("limiterKey() = %q, want %q", got, expectation.key)
			}
		})
	}
}
