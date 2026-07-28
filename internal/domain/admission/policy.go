// Package admission holds producer backpressure. Worker backpressure alone
// cannot save a system whose producers enqueue faster than it drains: the queue
// table keeps growing until the database is the outage (specification 28.2).
package admission

import (
	"errors"
	"fmt"
	"time"

	"github.com/madebyduy/RhinoQ/internal/contracts/diagnostic"
)

// Mode is what RhinoQ does with work that arrives at a full queue.
type Mode string

const (
	// Reject refuses the enqueue and tells the producer when to come back.
	Reject Mode = "reject"
	// Delay accepts the job but pushes its earliest run time out, trading
	// latency for acceptance.
	Delay Mode = "delay"
)

const (
	DefaultRetryAfter = 30 * time.Second
	DefaultDelayBy    = 30 * time.Second
)

var (
	ErrInvalidPolicy = errors.New("admission policy requires a positive max pending, a reserved critical budget below it and a supported overflow mode")
	// ErrOverCapacity matches every over-capacity rejection through errors.Is.
	ErrOverCapacity = errors.New("RHINOQ_QUEUE_OVER_CAPACITY")
)

// Policy is the per-queue admission budget.
type Policy struct {
	// MaxPending is the number of pending and retrying jobs a queue may hold.
	MaxPending int
	// ReservedCritical is the slice of MaxPending that only critical jobs may
	// use, so an overflowing report queue cannot block a payment job.
	ReservedCritical int
	OnOverflow       Mode
	// DelayBy is how far Delay pushes NotBefore.
	DelayBy time.Duration
	// RetryAfter is what Reject tells the producer to wait.
	RetryAfter time.Duration
}

func (p Policy) Validate() error {
	if p.MaxPending <= 0 || p.ReservedCritical < 0 || p.ReservedCritical >= p.MaxPending {
		return ErrInvalidPolicy
	}
	if p.OnOverflow != Reject && p.OnOverflow != Delay {
		return ErrInvalidPolicy
	}
	if p.DelayBy < 0 || p.RetryAfter < 0 {
		return ErrInvalidPolicy
	}
	return nil
}

func (p Policy) Normalize() Policy {
	if p.OnOverflow == "" {
		p.OnOverflow = Reject
	}
	if p.DelayBy <= 0 {
		p.DelayBy = DefaultDelayBy
	}
	if p.RetryAfter <= 0 {
		p.RetryAfter = DefaultRetryAfter
	}
	return p
}

// Capacity is how many pending jobs of this kind the queue accepts. Critical
// work may use the whole budget; everything else stops at the reserved line.
func (p Policy) Capacity(critical bool) int {
	if critical {
		return p.MaxPending
	}
	return p.MaxPending - p.ReservedCritical
}

// Decision is the outcome of an admission check.
type Decision struct {
	// DeferBy is added to the job's earliest run time. Zero means run as soon
	// as a worker is free.
	DeferBy time.Duration
}

// Decide answers whether a queue holding pending jobs may accept one more. It
// returns an *OverCapacityError when the answer is no.
func (p Policy) Decide(queue string, pending int, critical bool) (Decision, error) {
	policy := p.Normalize()
	capacity := policy.Capacity(critical)
	if pending < capacity {
		return Decision{}, nil
	}
	if policy.OnOverflow == Delay {
		return Decision{DeferBy: policy.DelayBy}, nil
	}
	return Decision{}, &OverCapacityError{
		Queue:      queue,
		Pending:    pending,
		Capacity:   capacity,
		Critical:   critical,
		RetryAfter: policy.RetryAfter,
	}
}

// OverCapacityError is the rejection a producer receives from a full queue.
type OverCapacityError struct {
	Queue      string
	Pending    int
	Capacity   int
	Critical   bool
	RetryAfter time.Duration
}

func (e *OverCapacityError) Error() string { return e.Message().Error() }

func (e *OverCapacityError) Unwrap() error { return ErrOverCapacity }

func (e *OverCapacityError) Message() diagnostic.Message {
	budget := "shared budget"
	if e.Critical {
		budget = "full budget including the critical reserve"
	}
	return diagnostic.Message{
		Code: "RHINOQ_QUEUE_OVER_CAPACITY",
		WhatHappened: fmt.Sprintf("queue: %s · pending: %d / %d (%s)\nretryAfter: %s",
			e.Queue, e.Pending, e.Capacity, budget, e.RetryAfter),
		WhyItMatters: "A queue that keeps accepting work it cannot drain grows until the\n" +
			"database is the outage. Rejecting here keeps the failure in the producer,\n" +
			"where it can be retried, instead of in storage, where it cannot.",
		WhatRhinoQDid: "Nothing was enqueued. No job was created, no idempotency key was\n" +
			"consumed, and jobs already in the queue keep running.",
		HowToFix: fmt.Sprintf("Retry after %s, or raise the budget once the queue drains:\n"+
			"  rhinoq queue admit %s --max-pending=<n> --reserved-critical=<n>\n"+
			"Jobs that must never be rejected should declare class critical.", e.RetryAfter, e.Queue),
		Verify: fmt.Sprintf("rhinoq queue counts %s", e.Queue),
	}
}
