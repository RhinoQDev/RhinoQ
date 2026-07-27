package retry

import (
	"math/rand"
	"time"
)

type Class string

const (
	Transient      Class = "transient"
	Permanent      Class = "permanent"
	RateLimited    Class = "rate_limited"
	DependencyDown Class = "dependency_down"
	Unknown        Class = "unknown"
	Cancelled      Class = "cancelled"
)

// UnknownMaxAttempts bounds how often an unclassified error is retried before
// the job is parked for an operator decision.
const UnknownMaxAttempts = 2

type Policy struct {
	MaxAttempts int
	BaseDelay   time.Duration
	MaxDelay    time.Duration
	Jitter      float64
	Random      func() float64
}

type Decision struct {
	Retry   bool
	Dead    bool
	Blocked bool
	// Delay is how long the job waits before becoming eligible again. The store
	// turns it into an absolute time using its own clock, so worker skew cannot
	// move a retry (specification 50.3).
	Delay     time.Duration
	NextRunAt time.Time
	Reason    string
}

func (p Policy) Decide(class Class, attempt int, now time.Time, retryAfter time.Duration) Decision {
	if attempt <= 0 || p.MaxAttempts <= 0 || attempt >= p.MaxAttempts {
		return Decision{Dead: class != Cancelled, Reason: "attempt limit reached"}
	}
	switch class {
	case Permanent:
		return Decision{Dead: true, Reason: "permanent error"}
	case Cancelled:
		return Decision{Reason: "cancelled"}
	case Unknown:
		// An unclassified error is retried cautiously and only a couple of
		// times. Treating it as transient hides real bugs behind a retry storm;
		// treating it as permanent throws away work that a second try would
		// have completed (specification 9.2).
		if attempt < UnknownMaxAttempts {
			return retryIn(p.delay(attempt), now, "unclassified error, retrying cautiously")
		}
		return Decision{Blocked: true, Reason: "unknown error requires decision"}
	case RateLimited:
		if retryAfter <= 0 {
			retryAfter = p.delay(attempt)
		}
		return retryIn(retryAfter, now, "provider rate limit")
	case Transient, DependencyDown:
		return retryIn(p.delay(attempt), now, "retryable dependency error")
	default:
		return Decision{Blocked: true, Reason: "unclassified error"}
	}
}

func retryIn(delay time.Duration, now time.Time, reason string) Decision {
	return Decision{Retry: true, Delay: delay, NextRunAt: now.Add(delay), Reason: reason}
}

func (p Policy) delay(attempt int) time.Duration {
	delay := p.BaseDelay
	for i := 1; i < attempt; i++ {
		delay *= 2
		if p.MaxDelay > 0 && delay >= p.MaxDelay {
			delay = p.MaxDelay
			break
		}
	}
	if p.MaxDelay > 0 && delay > p.MaxDelay {
		delay = p.MaxDelay
	}
	return p.applyJitter(delay)
}

func (p Policy) applyJitter(delay time.Duration) time.Duration {
	if delay <= 0 || p.Jitter <= 0 {
		return delay
	}
	jitter := p.Jitter
	if jitter > 1 {
		jitter = 1
	}
	random := p.Random
	if random == nil {
		random = rand.Float64
	}
	sample := random()
	if sample < 0 {
		sample = 0
	}
	if sample > 1 {
		sample = 1
	}
	return time.Duration(float64(delay) * (1 - jitter*sample))
}
