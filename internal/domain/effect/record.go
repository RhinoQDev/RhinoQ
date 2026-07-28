package effect

import (
	"errors"
	"fmt"
	"time"

	"github.com/madebyduy/RhinoQ/internal/domain/correlation"
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
	ID ID
	// JobID is set only when RhinoQ's own runtime ran the execution. It is what
	// keeps the foreign key and lease fencing for that case; an execution
	// another system performed leaves it empty and is identified by Execution.
	JobID string
	// Execution names the run that opened this effect, in whatever system
	// performed it. For a RhinoQ job it is correlation.ForJob(JobID).
	Execution correlation.ExecutionRef
	// Subject is the business thing the effect acted on. Optional, because a
	// caller may know the execution without knowing the subject.
	Subject        correlation.SubjectRef
	BusinessKey    string
	Name           string
	IdempotencyKey string
	State          State
	Irreversible   bool
	ExternalRef    string
	CreatedAt      time.Time
	// LeaseEpoch is the execution that opened this effect. It is written by the
	// store from the fencing token, never by the caller, and is meaningful only
	// for a RhinoQ execution: nothing else has a lease to fence against.
	LeaseEpoch int64
}

var (
	ErrInvalidRecord      = errors.New("effect execution, name, idempotency key and created time are required")
	ErrInvalidTransition  = errors.New("invalid effect transition")
	ErrConfirmationPolicy = errors.New("unsupported confirmation policy")
)

// NewRecord opens an effect for a RhinoQ job.
func NewRecord(id ID, jobID, name, key string, irreversible bool, now time.Time) (Record, error) {
	if jobID == "" {
		return Record{}, ErrInvalidRecord
	}
	return NewExternalRecord(
		id, correlation.ForJob(jobID), correlation.SubjectRef{}, "",
		name, key, irreversible, now,
	)
}

// NewExternalRecord opens an effect for an execution RhinoQ did not run.
//
// Such an effect cannot be lease-fenced: there is no RhinoQ lease, so nothing
// can prove that the caller still owns the work. Deduplication falls back to
// the execution reference plus the idempotency key, which is exactly the
// guarantee an external caller can actually provide.
func NewExternalRecord(
	id ID,
	execution correlation.ExecutionRef,
	subject correlation.SubjectRef,
	businessKey, name, key string,
	irreversible bool,
	now time.Time,
) (Record, error) {
	if id == "" || name == "" || key == "" || now.IsZero() {
		return Record{}, ErrInvalidRecord
	}
	execution, err := execution.Normalize()
	if err != nil {
		return Record{}, err
	}
	record := Record{
		ID: id, Execution: execution, BusinessKey: businessKey,
		Name: name, IdempotencyKey: key, State: Pending,
		Irreversible: irreversible, CreatedAt: now,
	}
	if !subject.Zero() {
		subject, err := subject.Normalize()
		if err != nil {
			return Record{}, err
		}
		record.Subject = subject
	}
	if jobID, ok := execution.JobID(); ok {
		record.JobID = jobID
	}
	return record, nil
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
