// Package provideroperation models one idempotent call to an external
// provider. Transport errors and provider outcomes are deliberately separate:
// after bytes may have left the process, "failed" is not an honest answer.
package provideroperation

import (
	"errors"
	"strings"
	"time"
)

type State string

const (
	Pending     State = "pending"
	Accepted    State = "accepted"
	Confirmed   State = "confirmed"
	Failed      State = "failed"
	NotHappened State = "not_happened"
	Rejected    State = "rejected"
	Uncertain   State = "uncertain"
)

type ID string

type ConfirmationPolicy string
type RetryPolicy string

const (
	ConfirmOnReturn ConfirmationPolicy = "on-return"
	ConfirmReadback ConfirmationPolicy = "readback"
	ConfirmWebhook  ConfirmationPolicy = "webhook"
	RetryNever      RetryPolicy        = "never"
	RetryWhenAbsent RetryPolicy        = "when-not-happened"
)

type Evidence struct {
	Sequence    int64
	OperationID ID
	Kind        string
	Payload     string
	CreatedAt   time.Time
}

type Record struct {
	ID             ID
	TaskID         string
	Provider       string
	Operation      string
	IdempotencyKey string
	Confirmation   ConfirmationPolicy
	RetryPolicy    RetryPolicy
	State          State
	ProviderID     string
	Evidence       string
	Reason         string
	Version        int64
	CreatedAt      time.Time
	UpdatedAt      time.Time
}

var (
	ErrInvalidRecord     = errors.New("provider operation requires id, provider, operation, idempotency key and time")
	ErrInvalidTransition = errors.New("invalid provider operation transition")
)

func New(id ID, taskID, provider, operation, key string, confirmation ConfirmationPolicy, retryPolicy RetryPolicy, now time.Time) (Record, error) {
	if strings.TrimSpace(string(id)) == "" || strings.TrimSpace(provider) == "" ||
		strings.TrimSpace(operation) == "" || strings.TrimSpace(key) == "" ||
		!confirmation.Valid() || !retryPolicy.Valid() || now.IsZero() {
		return Record{}, ErrInvalidRecord
	}
	return Record{ID: id, TaskID: strings.TrimSpace(taskID), Provider: provider, Operation: operation,
		IdempotencyKey: key, Confirmation: confirmation, RetryPolicy: retryPolicy,
		State: Pending, Version: 1,
		CreatedAt: now, UpdatedAt: now}, nil
}

func (p ConfirmationPolicy) Valid() bool {
	return p == ConfirmOnReturn || p == ConfirmReadback || p == ConfirmWebhook
}

func (p RetryPolicy) Valid() bool { return p == RetryNever || p == RetryWhenAbsent }

func (r Record) Accept(providerID string, now time.Time) (Record, error) {
	if r.State == Accepted && r.ProviderID == providerID {
		return r, nil
	}
	if r.State != Pending || strings.TrimSpace(providerID) == "" || now.IsZero() {
		return r, ErrInvalidTransition
	}
	r.State, r.ProviderID, r.Version, r.UpdatedAt = Accepted, providerID, r.Version+1, now
	return r, nil
}

func (r Record) Confirm(evidence string, now time.Time) (Record, error) {
	if r.State == Confirmed {
		return r, nil
	}
	if (r.State != Accepted && r.State != Uncertain) || strings.TrimSpace(evidence) == "" || now.IsZero() {
		return r, ErrInvalidTransition
	}
	r.State, r.Evidence, r.Reason, r.Version, r.UpdatedAt = Confirmed, evidence, "", r.Version+1, now
	return r, nil
}

func (r Record) Resolve(state State, reason string, now time.Time) (Record, error) {
	if state != NotHappened && state != Rejected && state != Failed && state != Uncertain {
		return r, ErrInvalidTransition
	}
	if r.State != Pending && r.State != Accepted && r.State != Uncertain {
		return r, ErrInvalidTransition
	}
	if state != Uncertain && strings.TrimSpace(reason) == "" || now.IsZero() {
		return r, ErrInvalidTransition
	}
	if r.State == state && r.Reason == reason {
		return r, nil
	}
	r.State, r.Reason, r.Version, r.UpdatedAt = state, reason, r.Version+1, now
	return r, nil
}

func (r Record) Retry(now time.Time) (Record, error) {
	if r.State != NotHappened || r.RetryPolicy != RetryWhenAbsent || now.IsZero() {
		return r, ErrInvalidTransition
	}
	r.State, r.Reason, r.ProviderID, r.Evidence = Pending, "", "", ""
	r.Version++
	r.UpdatedAt = now
	return r, nil
}
