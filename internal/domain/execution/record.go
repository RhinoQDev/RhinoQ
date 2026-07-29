package execution

import (
	"errors"
	"fmt"
	"strings"
	"time"
)

const RuntimeNative = "native"

// MaxFailureReasonLength bounds what a fan-out can push into a polled snapshot.
// Fifty failed items each carrying an unbounded provider error would make the
// snapshot the largest thing on the wire.
const MaxFailureReasonLength = 512

var (
	ErrInvalidRecord    = errors.New("invalid execution record")
	ErrInvalidReference = errors.New("invalid execution runtime reference")
	ErrAlreadyBound     = errors.New("execution runtime reference is already bound")
	ErrInvalidResult    = errors.New("invalid execution result reference")
)

type ID string

func (id ID) String() string { return string(id) }

// RuntimeReference identifies the concrete work item without making the Task
// domain depend on a queue implementation. Native executions reference a
// RhinoQ Job; external runtimes use their own stable execution ID.
type RuntimeReference struct {
	Runtime    string
	JobID      string
	ExternalID string
}

func (r RuntimeReference) Empty() bool {
	return strings.TrimSpace(r.JobID) == "" && strings.TrimSpace(r.ExternalID) == ""
}

func (r RuntimeReference) Valid() bool {
	runtime := strings.TrimSpace(r.Runtime)
	jobID := strings.TrimSpace(r.JobID)
	externalID := strings.TrimSpace(r.ExternalID)
	if runtime == "" {
		return false
	}
	if runtime == RuntimeNative {
		return jobID != "" && externalID == ""
	}
	return externalID != "" && jobID == ""
}

type Record struct {
	ID      ID
	TaskID  string
	Attempt int
	Runtime string
	// ResultRef points at where this attempt's own output lives. A Task holds
	// one aggregate reference; a fan-out needs one per item, otherwise the
	// application has to keep a parallel item store and the Task layer removes
	// no work at all.
	ResultRef string
	// FailureReason is user-facing prose for one failed attempt. It is not a
	// place for a stack trace or a payload: it is polled with the snapshot.
	FailureReason string
	Reference     RuntimeReference
	State         State
	Version       int64
	CreatedAt     time.Time
	UpdatedAt     time.Time
}

type Spec struct {
	ID      ID
	TaskID  string
	Attempt int
	Runtime string
	Now     time.Time
}

func NewRecord(spec Spec) (Record, error) {
	runtime := strings.TrimSpace(spec.Runtime)
	if spec.ID == "" || strings.TrimSpace(spec.TaskID) == "" ||
		spec.Attempt <= 0 || runtime == "" || spec.Now.IsZero() {
		return Record{}, ErrInvalidRecord
	}
	return Record{
		ID:        spec.ID,
		TaskID:    strings.TrimSpace(spec.TaskID),
		Attempt:   spec.Attempt,
		Runtime:   runtime,
		State:     PendingDispatch,
		Version:   1,
		CreatedAt: spec.Now,
		UpdatedAt: spec.Now,
	}, nil
}

// Bind records the durable runtime identity and advances the Execution to
// dispatched atomically at the domain boundary.
func (r Record) Bind(reference RuntimeReference, now time.Time) (Record, error) {
	if err := r.valid(now); err != nil {
		return r, err
	}
	if !r.Reference.Empty() || r.State != PendingDispatch {
		return r, ErrAlreadyBound
	}
	reference.Runtime = strings.TrimSpace(reference.Runtime)
	reference.JobID = strings.TrimSpace(reference.JobID)
	reference.ExternalID = strings.TrimSpace(reference.ExternalID)
	if reference.Runtime != r.Runtime || !reference.Valid() {
		return r, ErrInvalidReference
	}
	r.Reference = reference
	r.State = Dispatched
	r.Version++
	r.UpdatedAt = now
	return r, nil
}

func (r Record) Transition(to State, now time.Time) (Record, error) {
	if err := r.valid(now); err != nil {
		return r, err
	}
	next, err := Transition(r.State, to)
	if err != nil {
		return r, err
	}
	if next != PendingDispatch && next != Cancelled && !r.Reference.Valid() {
		return r, ErrInvalidReference
	}
	r.State = next
	r.Version++
	r.UpdatedAt = now
	return r, nil
}

// AttachResult records where this attempt's output landed. Writing it is
// separate from the state change so a worker can publish an artifact reference
// without the store having to trust that the two happened together.
func (r Record) AttachResult(resultRef string, now time.Time) (Record, error) {
	if err := r.valid(now); err != nil {
		return r, err
	}
	reference := strings.TrimSpace(resultRef)
	if reference == "" {
		return r, ErrInvalidResult
	}
	if reference == r.ResultRef {
		return r, nil
	}
	r.ResultRef = reference
	r.Version++
	r.UpdatedAt = now
	return r, nil
}

// Fail is Transition(Failed) plus the reason the user is owed. An empty reason
// is allowed: an adapter that cannot explain the failure must still be able to
// record it.
func (r Record) Fail(reason string, now time.Time) (Record, error) {
	next, err := r.Transition(Failed, now)
	if err != nil {
		return r, err
	}
	next.FailureReason = truncate(strings.TrimSpace(reason), MaxFailureReasonLength)
	return next, nil
}

// truncate bounds by runes, not bytes: a reason cut mid-character would put
// invalid UTF-8 into every subsequent snapshot.
func truncate(value string, limit int) string {
	runes := []rune(value)
	if len(runes) <= limit {
		return value
	}
	return string(runes[:limit]) + "…"
}

func (r Record) valid(now time.Time) error {
	if r.ID == "" || strings.TrimSpace(r.TaskID) == "" || r.Attempt <= 0 ||
		strings.TrimSpace(r.Runtime) == "" || !r.State.Valid() || r.Version <= 0 ||
		r.CreatedAt.IsZero() || r.UpdatedAt.IsZero() || now.IsZero() {
		return fmt.Errorf("%w: malformed record", ErrInvalidRecord)
	}
	if !r.Reference.Empty() && (r.Reference.Runtime != r.Runtime || !r.Reference.Valid()) {
		return fmt.Errorf("%w: malformed runtime reference", ErrInvalidRecord)
	}
	return nil
}
