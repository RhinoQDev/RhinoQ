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

type Policy struct {
	MaxAttempts int
	BaseDelay   time.Duration
	MaxDelay    time.Duration
	Jitter      float64
	Random      func() float64
}

type Decision struct {
	Retry     bool
	Dead      bool
	Blocked   bool
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
		return Decision{Blocked: true, Reason: "unknown error requires decision"}
	case RateLimited:
		if retryAfter <= 0 {
			retryAfter = p.delay(attempt)
		}
		return Decision{Retry: true, NextRunAt: now.Add(retryAfter), Reason: "provider rate limit"}
	case Transient, DependencyDown:
		return Decision{Retry: true, NextRunAt: now.Add(p.delay(attempt)), Reason: "retryable dependency error"}
	default:
		return Decision{Blocked: true, Reason: "unclassified error"}
	}
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
