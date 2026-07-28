// Package finding holds the lifecycle of an operational finding. Detection
// alone is not enough: without a lifecycle the Needs Attention screen fills up
// with warnings nobody has triaged, and after two weeks nobody reads it at all
// (specification 12.2c).
package finding

import (
	"errors"
	"fmt"
	"strings"
	"time"
)

type Status string

const (
	// Open is a finding nobody has looked at yet.
	Open Status = "open"
	// Acknowledged means a human has seen it and owns it.
	Acknowledged Status = "acknowledged"
	// RepairProposed means a repair plan exists and is waiting for approval.
	RepairProposed Status = "repair_proposed"
	// Repairing means the approved repair is running.
	Repairing Status = "repairing"
	// Resolved means the drift is gone.
	Resolved Status = "resolved"
	// FalsePositive means the rule was wrong. It must expire, because a
	// permanent dismissal is how a real problem gets buried.
	FalsePositive Status = "false_positive"
	// Ignored means the drift is real but accepted for now. It must expire too.
	Ignored Status = "ignored"
	// Regressed is the most important signal in the whole lifecycle: something
	// that was repaired came back, which means the repair did not fix the cause.
	Regressed Status = "regressed"

	MaxRuleIDBytes      = 128
	MaxSubjectTypeBytes = 64
	MaxSubjectIDBytes   = 256
	MaxEvidenceBytes    = 64 << 10
	MaxActorBytes       = 256
	MaxReasonBytes      = 4 << 10
)

func (s Status) Valid() bool {
	switch s {
	case Open, Acknowledged, RepairProposed, Repairing, Resolved, FalsePositive, Ignored, Regressed:
		return true
	default:
		return false
	}
}

// Suppressed reports whether a status hides the finding from the daily view.
func (s Status) Suppressed() bool { return s == FalsePositive || s == Ignored }

// NeedsExpiry reports whether a status may only be set with a deadline.
func (s Status) NeedsExpiry() bool { return s.Suppressed() }

// Terminal reports whether a status means the finding is done for now.
func (s Status) Terminal() bool { return s == Resolved }

var (
	ErrInvalidKey        = errors.New("a finding needs a rule, a subject type, a subject id and a non-negative invariant version")
	ErrInvalidStatus     = errors.New("unknown finding status")
	ErrExpiryRequired    = errors.New("false_positive and ignored must carry an expiry: a permanent dismissal buries the problem")
	ErrExpiryInThePast   = errors.New("a suppression expiry must be in the future")
	ErrReasonRequired    = errors.New("suppressing or resolving a finding requires a reason")
	ErrActorRequired     = errors.New("a lifecycle change requires an actor")
	ErrInvalidTransition = errors.New("invalid finding transition")
	ErrObservationTime   = errors.New("an observation needs a time")
	ErrEvidenceTooLarge  = errors.New("finding evidence exceeds 64 KiB")
	ErrActorTooLarge     = errors.New("finding actor exceeds 256 bytes")
	ErrReasonTooLarge    = errors.New("finding reason exceeds 4 KiB")
)

// Key identifies a finding. The invariant version is part of the key so that a
// deployment which changes what a rule checks produces a new finding instead of
// silently merging into the old one (specification 12.2d).
type Key struct {
	RuleID                   string
	SubjectType              string
	SubjectID                string
	ObservedInvariantVersion int
}

func (k Key) Validate() error {
	if strings.TrimSpace(k.RuleID) == "" || strings.TrimSpace(k.SubjectType) == "" ||
		strings.TrimSpace(k.SubjectID) == "" || k.ObservedInvariantVersion < 0 ||
		len(k.RuleID) > MaxRuleIDBytes || len(k.SubjectType) > MaxSubjectTypeBytes ||
		len(k.SubjectID) > MaxSubjectIDBytes {
		return ErrInvalidKey
	}
	return nil
}

func (k Key) String() string {
	return fmt.Sprintf("%s/%s/%s@v%d", k.RuleID, k.SubjectType, k.SubjectID, k.ObservedInvariantVersion)
}

// Record is one finding and its history.
type Record struct {
	Key
	Status Status
	// FirstSeen and LastSeen bound how long the drift has existed;
	// OccurrenceCount says how often it was observed, so a rule running every
	// minute does not create sixty findings for one problem.
	FirstSeen       time.Time
	LastSeen        time.Time
	OccurrenceCount int
	LatestEvidence  string
	// Actor and Reason record who last changed the status and why.
	Actor  string
	Reason string
	// SuppressedUntil is when a false_positive or ignored finding comes back.
	SuppressedUntil time.Time
	ResolvedAt      time.Time
	UpdatedAt       time.Time
}

// Event is one immutable fact in a finding's lifecycle. The current record is
// optimized for the operator inbox; events preserve how it got there.
type Event struct {
	Sequence int64
	Key
	Kind       string
	FromStatus Status
	ToStatus   Status
	Actor      string
	Reason     string
	Evidence   string
	Until      time.Time
	OccurredAt time.Time
}

const (
	EventObserved   = "observed"
	EventTransition = "transitioned"
)

// Suppressed reports whether the finding is currently hidden.
func (r Record) Suppressed(now time.Time) bool {
	return r.Status.Suppressed() && r.SuppressedUntil.After(now)
}

// Observation is one sighting of a drift by a rule.
type Observation struct {
	Key
	Evidence   string
	ObservedAt time.Time
}

func (o Observation) Validate() error {
	if err := o.Key.Validate(); err != nil {
		return err
	}
	if o.ObservedAt.IsZero() {
		return ErrObservationTime
	}
	if len(o.Evidence) > MaxEvidenceBytes {
		return ErrEvidenceTooLarge
	}
	return nil
}

// Apply folds one observation into the existing record, or creates the first
// one. Seeing a drift again is normally just a counter bump; the exception is
// the case that matters most, where something already resolved comes back.
func Apply(existing Record, found bool, observation Observation) (Record, error) {
	if err := observation.Validate(); err != nil {
		return Record{}, err
	}
	if !found {
		return Record{
			Key: observation.Key, Status: Open,
			FirstSeen: observation.ObservedAt, LastSeen: observation.ObservedAt,
			OccurrenceCount: 1, LatestEvidence: observation.Evidence,
			UpdatedAt: observation.ObservedAt,
		}, nil
	}

	updated := existing
	updated.LastSeen = observation.ObservedAt
	updated.OccurrenceCount = existing.OccurrenceCount + 1
	if observation.Evidence != "" {
		updated.LatestEvidence = observation.Evidence
	}
	updated.UpdatedAt = observation.ObservedAt

	switch {
	case existing.Status == Resolved:
		// The repair did not fix the cause. Say so loudly rather than quietly
		// reopening.
		updated.Status = Regressed
		updated.Actor = ""
		updated.Reason = "the drift returned after it was resolved"
		updated.ResolvedAt = time.Time{}
	case existing.Status.Suppressed() && !existing.SuppressedUntil.After(observation.ObservedAt):
		// The dismissal ran out and the drift is still here.
		updated.Status = Open
		updated.Reason = "the suppression expired and the drift is still present"
		updated.SuppressedUntil = time.Time{}
	}
	return updated, nil
}

// Transition is an operator-driven status change.
type Transition struct {
	Status Status
	Actor  string
	Reason string
	// Until is required by false_positive and ignored.
	Until time.Time
	At    time.Time
}

// allowedTransitions is the lifecycle from specification 12.2c. Suppression is
// reachable from any live state, because an operator has to be able to silence
// noise at the moment they meet it.
var allowedTransitions = map[Status][]Status{
	Open:           {Acknowledged, RepairProposed, Resolved, FalsePositive, Ignored},
	Acknowledged:   {RepairProposed, Repairing, Resolved, FalsePositive, Ignored},
	RepairProposed: {Repairing, Acknowledged, Resolved, FalsePositive, Ignored},
	Repairing:      {Resolved, Acknowledged, FalsePositive, Ignored},
	Regressed:      {Acknowledged, RepairProposed, Resolved, FalsePositive, Ignored},
	FalsePositive:  {Open, Acknowledged},
	Ignored:        {Open, Acknowledged},
	Resolved:       {Acknowledged},
}

func CanTransition(from, to Status) bool {
	for _, allowed := range allowedTransitions[from] {
		if allowed == to {
			return true
		}
	}
	return false
}

// ApplyTransition validates and applies an operator decision.
func ApplyTransition(existing Record, transition Transition) (Record, error) {
	if !transition.Status.Valid() {
		return existing, ErrInvalidStatus
	}
	if transition.Status == Regressed {
		// Regression is something RhinoQ observes, never something a person
		// declares.
		return existing, fmt.Errorf("%w: regressed is set by observation, not by hand", ErrInvalidTransition)
	}
	if strings.TrimSpace(transition.Actor) == "" {
		return existing, ErrActorRequired
	}
	if len(transition.Actor) > MaxActorBytes {
		return existing, ErrActorTooLarge
	}
	if len(transition.Reason) > MaxReasonBytes {
		return existing, ErrReasonTooLarge
	}
	if transition.At.IsZero() {
		return existing, ErrObservationTime
	}
	if !CanTransition(existing.Status, transition.Status) {
		return existing, fmt.Errorf("%w: %s -> %s", ErrInvalidTransition, existing.Status, transition.Status)
	}
	if transition.Status.NeedsExpiry() {
		if transition.Until.IsZero() {
			return existing, ErrExpiryRequired
		}
		if !transition.Until.After(transition.At) {
			return existing, ErrExpiryInThePast
		}
	}
	if (transition.Status.Suppressed() || transition.Status == Resolved) &&
		strings.TrimSpace(transition.Reason) == "" {
		return existing, ErrReasonRequired
	}

	updated := existing
	updated.Status = transition.Status
	updated.Actor = transition.Actor
	updated.Reason = transition.Reason
	updated.UpdatedAt = transition.At
	updated.SuppressedUntil = time.Time{}
	updated.ResolvedAt = time.Time{}
	if transition.Status.NeedsExpiry() {
		updated.SuppressedUntil = transition.Until
	}
	if transition.Status == Resolved {
		updated.ResolvedAt = transition.At
	}
	return updated, nil
}

// Query filters the finding list.
type Query struct {
	RuleID      string
	SubjectType string
	SubjectID   string
	Statuses    []Status
	// IncludeSuppressed keeps dismissed findings in the result. The daily view
	// leaves it off; an audit turns it on.
	IncludeSuppressed bool
	Now               time.Time
	Offset            int
	Limit             int
}

func (q Query) Validate() error {
	if q.Offset < 0 || q.Limit <= 0 || q.Limit > 1000 {
		return errors.New("finding offset must be non-negative and limit must be between 1 and 1000")
	}
	if len(q.RuleID) > MaxRuleIDBytes || len(q.SubjectType) > MaxSubjectTypeBytes ||
		len(q.SubjectID) > MaxSubjectIDBytes {
		return ErrInvalidKey
	}
	for _, status := range q.Statuses {
		if !status.Valid() {
			return ErrInvalidStatus
		}
	}
	return nil
}

// Matches reports whether a record belongs in the result of a query.
func (q Query) Matches(record Record) bool {
	if q.RuleID != "" && record.RuleID != q.RuleID {
		return false
	}
	if q.SubjectType != "" && record.SubjectType != q.SubjectType {
		return false
	}
	if q.SubjectID != "" && record.SubjectID != q.SubjectID {
		return false
	}
	if len(q.Statuses) > 0 {
		matched := false
		for _, status := range q.Statuses {
			if record.Status == status {
				matched = true
				break
			}
		}
		if !matched {
			return false
		}
	}
	if !q.IncludeSuppressed && record.Suppressed(q.Now) {
		return false
	}
	return true
}
