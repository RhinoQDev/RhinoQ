// Package correlation names the things an integrity claim is about, so the
// model does not assume RhinoQ ran the work.
//
// Effects used to hang off a RhinoQ job id. That made the Effect Ledger
// unusable for the case it is most needed in: a team already running BullMQ,
// Temporal, cron or a hand-written worker has no RhinoQ job to attach to, and
// asking them to migrate their queue before they can check whether their data
// is correct inverts the order in which trust is earned.
//
// A job id is now one kind of execution reference rather than a precondition.
package correlation

import (
	"errors"
	"strings"
)

const (
	MaxTypeBytes        = 64
	MaxIDBytes          = 256
	MaxSourceBytes      = 64
	MaxBusinessKeyBytes = 256
	MaxExternalRefBytes = 512
)

var (
	ErrSubjectRequired   = errors.New("subject type and id are required")
	ErrExecutionInvalid  = errors.New("execution reference needs both a source system and a source id")
	ErrCorrelationBounds = errors.New("correlation field exceeds its length bound")
)

// SubjectRef names the business thing an invariant is about: a report, an
// order, an account. It is what an operator recognises, and what survives when
// the execution that produced it is long gone.
type SubjectRef struct {
	Type string
	ID   string
}

func (s SubjectRef) Zero() bool {
	return strings.TrimSpace(s.Type) == "" && strings.TrimSpace(s.ID) == ""
}

func (s SubjectRef) Normalize() (SubjectRef, error) {
	s.Type = strings.TrimSpace(s.Type)
	s.ID = strings.TrimSpace(s.ID)
	if s.Type == "" || s.ID == "" {
		return SubjectRef{}, ErrSubjectRequired
	}
	if len(s.Type) > MaxTypeBytes || len(s.ID) > MaxIDBytes {
		return SubjectRef{}, ErrCorrelationBounds
	}
	return s, nil
}

// SourceRhinoQ marks an execution RhinoQ's own runtime performed. It is a value
// like any other source system, which is the point: the integrity model treats
// a RhinoQ job and a BullMQ job the same way.
const SourceRhinoQ = "rhinoq"

// ExecutionRef names the run that acted on a subject, in whatever system
// actually performed it.
type ExecutionRef struct {
	SourceSystem string
	SourceID     string
}

// ForJob builds the execution reference for a RhinoQ job.
func ForJob(jobID string) ExecutionRef {
	return ExecutionRef{SourceSystem: SourceRhinoQ, SourceID: jobID}
}

func (e ExecutionRef) Zero() bool {
	return strings.TrimSpace(e.SourceSystem) == "" && strings.TrimSpace(e.SourceID) == ""
}

// IsRhinoQJob reports whether this execution is one RhinoQ leased and fenced.
// It is what decides whether an effect can be protected by a lease epoch at
// all: an execution RhinoQ did not run has no lease to fence against.
func (e ExecutionRef) IsRhinoQJob() bool {
	return strings.TrimSpace(e.SourceSystem) == SourceRhinoQ
}

func (e ExecutionRef) Normalize() (ExecutionRef, error) {
	e.SourceSystem = strings.TrimSpace(e.SourceSystem)
	e.SourceID = strings.TrimSpace(e.SourceID)
	if e.SourceSystem == "" || e.SourceID == "" {
		return ExecutionRef{}, ErrExecutionInvalid
	}
	if len(e.SourceSystem) > MaxSourceBytes || len(e.SourceID) > MaxIDBytes {
		return ExecutionRef{}, ErrCorrelationBounds
	}
	return e, nil
}

// JobID returns the RhinoQ job id this reference points at, if any. It is what
// lets the runtime plane keep its foreign key while the integrity plane stays
// agnostic about who ran the work.
func (e ExecutionRef) JobID() (string, bool) {
	if !e.IsRhinoQJob() {
		return "", false
	}
	id := strings.TrimSpace(e.SourceID)
	return id, id != ""
}

// Correlation ties one business subject to the execution that acted on it and
// to whatever the outside world calls the result.
//
// Only Subject is required. An invariant can be checked without knowing which
// run produced the state - that is exactly the position someone is in when they
// point RhinoQ at a table they did not have RhinoQ write.
type Correlation struct {
	// BusinessKey is the stable identifier the application already uses, when
	// it differs from the subject id.
	BusinessKey string
	Subject     SubjectRef
	// Execution is optional.
	Execution *ExecutionRef
	// ExternalRef is what the provider calls the result: an object key, a
	// provider run id, a receipt.
	ExternalRef string
}

func (c Correlation) Normalize() (Correlation, error) {
	subject, err := c.Subject.Normalize()
	if err != nil {
		return Correlation{}, err
	}
	c.Subject = subject
	c.BusinessKey = strings.TrimSpace(c.BusinessKey)
	c.ExternalRef = strings.TrimSpace(c.ExternalRef)
	if len(c.BusinessKey) > MaxBusinessKeyBytes ||
		len(c.ExternalRef) > MaxExternalRefBytes {
		return Correlation{}, ErrCorrelationBounds
	}
	if c.Execution != nil {
		execution, err := c.Execution.Normalize()
		if err != nil {
			return Correlation{}, err
		}
		c.Execution = &execution
	}
	// The business key defaults to the subject id rather than staying empty, so
	// a timeline query has one column to group on whether or not the
	// application maintains a separate key.
	if c.BusinessKey == "" {
		c.BusinessKey = c.Subject.ID
	}
	return c, nil
}
