package agent

import (
	"sync"
	"time"
)

// The Gateway used to hold one token bucket for the whole process. That budget
// is a shared resource with no owner: the caller that polls hardest gets it,
// and every other caller is rate-limited by someone else's traffic. On a
// single-tenant deployment nobody notices. On a Gateway serving several Task
// credentials it means one adopter's retry storm returns 429 to everyone else,
// and the 429 tells them to slow down — which is not the problem and does not
// help.
//
// So the budget is split. Each authenticated caller draws from its own bucket
// first, and the process-wide bucket stays as a ceiling on the whole Gateway.
// A caller can still use the entire budget when nothing else is running; it
// just cannot take it away from a caller that is.
//
// The key space is bounded by configuration — one entry per Task credential
// plus one for the operator token — so the map cannot grow from traffic and
// needs no eviction. An unauthenticated development Gateway shares one key,
// which is correct: there is nothing to tell those callers apart.

// limitScope names which budget refused a request, so the response can say
// something the caller can act on.
type limitScope string

const (
	scopeCaller  limitScope = "caller"
	scopeGateway limitScope = "gateway"
)

type tokenBucket struct {
	rate, tokens, burst float64
	last                time.Time
}

func newTokenBucket(rate float64, burst int, now time.Time) *tokenBucket {
	return &tokenBucket{rate: rate, tokens: float64(burst), burst: float64(burst), last: now}
}

// take removes one token, or reports how long until one exists.
func (b *tokenBucket) take(now time.Time) (bool, time.Duration) {
	if elapsed := now.Sub(b.last).Seconds(); elapsed > 0 {
		b.tokens += elapsed * b.rate
		if b.tokens > b.burst {
			b.tokens = b.burst
		}
		b.last = now
	}
	if b.tokens >= 1 {
		b.tokens--
		return true, 0
	}
	retry := time.Duration((1 - b.tokens) / b.rate * float64(time.Second))
	if retry < time.Millisecond {
		retry = time.Millisecond
	}
	return false, retry
}

// refund returns a token taken by a bucket whose sibling then refused the
// request. Without it, a caller stopped by the Gateway ceiling would still be
// charged against its own budget, and would keep paying for a queue it never
// entered.
func (b *tokenBucket) refund() {
	if b.tokens+1 <= b.burst {
		b.tokens++
	}
}

type requestLimiter struct {
	mu sync.Mutex

	gateway *tokenBucket

	callerRate  float64
	callerBurst int
	callers     map[string]*tokenBucket
}

// newRequestLimiter builds the two-level limiter.
//
// A zero or negative per-caller rate means the caller budget is the Gateway
// budget, which is exactly the previous single-bucket behaviour and is the
// right default when only one credential exists.
func newRequestLimiter(rate float64, burst int, callerRate float64, callerBurst int) *requestLimiter {
	if callerRate <= 0 {
		callerRate = rate
	}
	if callerBurst <= 0 {
		callerBurst = burst
	}
	return &requestLimiter{
		gateway:     newTokenBucket(rate, burst, time.Now()),
		callerRate:  callerRate,
		callerBurst: callerBurst,
		callers:     make(map[string]*tokenBucket),
	}
}

// Allow charges the caller's bucket and then the Gateway ceiling. The caller is
// charged first because that is the limit an adopter can do something about;
// the ceiling exists to protect the process, and hitting it is an operator
// problem rather than a caller problem.
func (l *requestLimiter) Allow(key string, now time.Time) (bool, time.Duration, limitScope) {
	if key == "" {
		key = "anonymous"
	}
	l.mu.Lock()
	defer l.mu.Unlock()

	caller, found := l.callers[key]
	if !found {
		caller = newTokenBucket(l.callerRate, l.callerBurst, now)
		l.callers[key] = caller
	}
	if ok, retry := caller.take(now); !ok {
		return false, retry, scopeCaller
	}
	if ok, retry := l.gateway.take(now); !ok {
		caller.refund()
		return false, retry, scopeGateway
	}
	return true, 0, ""
}

// fairCallerBurst derives a per-caller budget for a Gateway that serves several
// credentials and was not told what the split should be.
//
// The division is deliberate and only applies when there is something to
// divide: with one credential the caller budget is the Gateway budget and
// nothing changes for existing deployments. The floor exists because a share so
// small that a single page load exceeds it would be a worse failure than the
// unfairness it was meant to prevent.
func fairCallerShare(total float64, credentials int, floor float64) float64 {
	if credentials < 2 {
		return total
	}
	share := total / float64(credentials)
	if share < floor {
		return floor
	}
	return share
}
