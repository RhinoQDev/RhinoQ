package effect

import (
	"errors"
	"fmt"
	"time"
)

type State string

const (
	Pending     State = "pending"
	Confirmed   State = "confirmed"
	Uncertain   State = "uncertain"
	Rejected    State = "rejected"
	NotHappened State = "not_happened"
)

type ConfirmationKind string

const (
	OnReturn       ConfirmationKind = "on-return"
	ExternalSignal ConfirmationKind = "external-signal"
	Verify         ConfirmationKind = "verify"
	Predicate      ConfirmationKind = "predicate"
)

type ConfirmationPolicy struct {
	Kind            ConfirmationKind
	CompletedStatus string
}

type ID string

type Record struct {
	ID             ID
	JobID          string
	Name           string
	IdempotencyKey string
	State          State
	Irreversible   bool
	ExternalRef    string
	CreatedAt      time.Time
}

var (
	ErrInvalidRecord      = errors.New("effect job, name, idempotency key and created time are required")
	ErrInvalidTransition  = errors.New("invalid effect transition")
	ErrConfirmationPolicy = errors.New("unsupported confirmation policy")
)

func NewRecord(id ID, jobID, name, key string, irreversible bool, now time.Time) (Record, error) {
	if id == "" || jobID == "" || name == "" || key == "" || now.IsZero() {
		return Record{}, ErrInvalidRecord
	}
	return Record{ID: id, JobID: jobID, Name: name, IdempotencyKey: key, State: Pending, Irreversible: irreversible, CreatedAt: now}, nil
}

func (r Record) Confirm(policy ConfirmationPolicy, status string) (Record, error) {
	if r.State != Pending {
		return r, fmt.Errorf("%w: %s -> confirmation", ErrInvalidTransition, r.State)
	}
	confirmed := false
	switch policy.Kind {
	case OnReturn:
		confirmed = true
	case ExternalSignal, Verify:
		return r, nil
	case Predicate:
		confirmed = policy.CompletedStatus != "" && status == policy.CompletedStatus
	default:
		return r, ErrConfirmationPolicy
	}
	if confirmed {
		r.State = Confirmed
		r.ExternalRef = status
	}
	return r, nil
}

func (r Record) MarkUncertain() (Record, error) {
	if r.State != Pending {
		return r, fmt.Errorf("%w: %s -> uncertain", ErrInvalidTransition, r.State)
	}
	r.State = Uncertain
	return r, nil
}
