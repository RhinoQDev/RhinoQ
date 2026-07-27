package outcome

import (
	"errors"
	"fmt"
	"time"
)

type State string

const (
	Pending      State = "pending"
	Achieved     State = "achieved"
	Mismatch     State = "mismatch"
	Unverifiable State = "unverifiable"
	Stale        State = "stale"
)

type Observation struct {
	State           State
	Reason          string
	ObservedVersion int64
}

type Contract struct {
	Version         int
	ExpectedVersion int64
	NotBefore       time.Time
	Deadline        time.Time
}

type Record struct {
	ID              string
	JobID           string
	ContractVersion int
	State           State
	Reason          string
	ObservedVersion int64
	UpdatedAt       time.Time
}

var (
	ErrInvalidContract = errors.New("outcome contract is invalid")
	ErrInvalidOutcome  = errors.New("outcome record is invalid")
)

func NewRecord(id, jobID string, contract Contract, now time.Time) (Record, error) {
	if id == "" || jobID == "" || contract.Version <= 0 || now.IsZero() {
		return Record{}, ErrInvalidOutcome
	}
	if !contract.NotBefore.IsZero() && !contract.Deadline.IsZero() && contract.Deadline.Before(contract.NotBefore) {
		return Record{}, ErrInvalidContract
	}
	return Record{ID: id, JobID: jobID, ContractVersion: contract.Version, State: Pending, UpdatedAt: now}, nil
}

func (r Record) Apply(observation Observation, now time.Time) (Record, error) {
	if r.ID == "" || r.JobID == "" || r.ContractVersion <= 0 || now.IsZero() {
		return r, ErrInvalidOutcome
	}
	if observation.State != Achieved && observation.State != Mismatch && observation.State != Unverifiable && observation.State != Stale {
		return r, fmt.Errorf("unsupported outcome observation: %s", observation.State)
	}
	r.State = observation.State
	r.Reason = observation.Reason
	r.ObservedVersion = observation.ObservedVersion
	r.UpdatedAt = now
	return r, nil
}
