package notificationdelivery

import (
	"errors"
	"strings"
	"time"
)

type State string

const (
	Pending State = "pending"
	Sent    State = "sent"
	Failed  State = "failed"
	Dead    State = "dead"
)

type Record struct {
	ID, EventID, DestinationID   string
	Payload                      string
	State                        State
	Attempts                     int
	Version                      int64
	LastError                    string
	NextAttemptAt                time.Time
	LeaseOwner                   string
	LeaseUntil                   time.Time
	CreatedAt, UpdatedAt, SentAt time.Time
}

func (r Record) WithPayload(payload string) (Record, error) {
	if strings.TrimSpace(payload) == "" {
		return r, errors.New("notification payload is required")
	}
	r.Payload = payload
	return r, nil
}

func New(id, eventID, destinationID string, now time.Time) (Record, error) {
	if strings.TrimSpace(id) == "" || strings.TrimSpace(eventID) == "" || strings.TrimSpace(destinationID) == "" || now.IsZero() {
		return Record{}, errors.New("notification delivery requires id, event, destination and time")
	}
	return Record{ID: id, EventID: eventID, DestinationID: destinationID, State: Pending, Attempts: 1, Version: 1, NextAttemptAt: now, CreatedAt: now, UpdatedAt: now}, nil
}

func (r Record) Retry(now time.Time) (Record, error) {
	if r.State != Failed || now.IsZero() {
		return r, errors.New("only a failed notification may retry")
	}
	r.State, r.LastError, r.UpdatedAt = Pending, "", now
	r.NextAttemptAt = now
	r.LeaseOwner, r.LeaseUntil = "", time.Time{}
	r.Attempts++
	r.Version++
	return r, nil
}
func (r Record) Complete(now time.Time) (Record, error) {
	if r.State == Sent {
		return r, nil
	}
	if r.State != Pending || now.IsZero() {
		return r, errors.New("notification is not pending")
	}
	r.State, r.SentAt, r.UpdatedAt = Sent, now, now
	r.LeaseOwner, r.LeaseUntil = "", time.Time{}
	r.Version++
	return r, nil
}
func (r Record) Fail(reason string, now time.Time) (Record, error) {
	if r.State != Pending || strings.TrimSpace(reason) == "" || now.IsZero() {
		return r, errors.New("notification failure requires a pending delivery and reason")
	}
	r.State, r.LastError, r.NextAttemptAt, r.UpdatedAt = Failed, reason, now, now
	r.LeaseOwner, r.LeaseUntil = "", time.Time{}
	r.Version++
	return r, nil
}

// FailAt records a failed attempt and leaves it eligible for a future claim.
// The scheduler owns the backoff decision; the domain only requires a real
// reason and a non-past schedule.
func (r Record) FailAt(reason string, now, next time.Time) (Record, error) {
	if r.State != Pending || strings.TrimSpace(reason) == "" || now.IsZero() || next.IsZero() || next.Before(now) {
		return r, errors.New("notification retry requires a pending delivery and future time")
	}
	r.State, r.LastError, r.NextAttemptAt, r.UpdatedAt = Failed, reason, next, now
	r.LeaseOwner, r.LeaseUntil = "", time.Time{}
	r.Version++
	return r, nil
}

func (r Record) DeadLetter(reason string, now time.Time) (Record, error) {
	if r.State != Pending || strings.TrimSpace(reason) == "" || now.IsZero() {
		return r, errors.New("notification dead-letter requires a pending delivery and reason")
	}
	r.State, r.LastError, r.UpdatedAt = Dead, reason, now
	r.LeaseOwner, r.LeaseUntil = "", time.Time{}
	r.Version++
	return r, nil
}

// Claim marks a delivery as owned by one scheduler process. PostgreSQL uses
// the same transition in one SKIP LOCKED statement; this method keeps the
// in-memory adapter honest for tests and local development.
func (r Record) Claim(owner string, now time.Time, lease time.Duration) (Record, error) {
	if (r.State != Pending && r.State != Failed) || strings.TrimSpace(owner) == "" || now.IsZero() || lease <= 0 {
		return r, errors.New("notification claim requires a pending or failed delivery, owner and lease")
	}
	if !r.LeaseUntil.IsZero() && r.LeaseUntil.After(now) && r.LeaseOwner != owner {
		return r, errors.New("notification delivery is leased by another owner")
	}
	if r.State == Failed {
		r.Attempts++
	}
	r.State, r.LeaseOwner, r.LeaseUntil, r.UpdatedAt = Pending, owner, now.Add(lease), now
	r.Version++
	return r, nil
}
