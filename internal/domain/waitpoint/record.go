// Package waitpoint owns the durable state machine for asynchronous tasks
// that must pause until input, approval, or a webhook arrives.
package waitpoint

import (
	"errors"
	"strings"
	"time"
)

type State string
type Kind string

const (
	Waiting   State = "waiting"
	Resolved  State = "resolved"
	Expired   State = "expired"
	Cancelled State = "cancelled"
	Input     Kind  = "input"
	Approval  Kind  = "approval"
	Webhook   Kind  = "webhook"
)

var (
	ErrInvalidRecord      = errors.New("invalid waitpoint record")
	ErrAlreadySettled     = errors.New("waitpoint is already settled")
	ErrResolutionConflict = errors.New("waitpoint resolution conflicts with the durable result")
)

type ID string

func (id ID) String() string { return string(id) }

type Spec struct {
	ID, TaskID, Key string
	Kind            Kind
	SchemaVersion   int
	Deadline        time.Time
	Now             time.Time
}

type Record struct {
	ID             ID
	TaskID         string
	Key            string
	Kind           Kind
	SchemaVersion  int
	State          State
	Deadline       time.Time
	Resolution     []byte
	ResolutionHash string
	ResolvedBy     string
	ResolutionID   string
	ResolvedAt     time.Time
	Version        int64
	CreatedAt      time.Time
	UpdatedAt      time.Time
}

func New(spec Spec) (Record, error) {
	spec.ID, spec.TaskID, spec.Key = strings.TrimSpace(spec.ID), strings.TrimSpace(spec.TaskID), strings.TrimSpace(spec.Key)
	if spec.ID == "" || spec.TaskID == "" || spec.Key == "" || spec.SchemaVersion <= 0 || spec.Now.IsZero() ||
		(spec.Kind != Input && spec.Kind != Approval && spec.Kind != Webhook) ||
		(!spec.Deadline.IsZero() && !spec.Deadline.After(spec.Now)) {
		return Record{}, ErrInvalidRecord
	}
	return Record{ID: ID(spec.ID), TaskID: spec.TaskID, Key: spec.Key, Kind: spec.Kind,
		SchemaVersion: spec.SchemaVersion, State: Waiting, Deadline: spec.Deadline,
		Version: 1, CreatedAt: spec.Now, UpdatedAt: spec.Now}, nil
}

func (r Record) Resolve(resolution []byte, hash, resolutionID, actor string, now time.Time) (Record, error) {
	hash, resolutionID, actor = strings.TrimSpace(hash), strings.TrimSpace(resolutionID), strings.TrimSpace(actor)
	if len(resolution) == 0 || hash == "" || resolutionID == "" || actor == "" || now.IsZero() || now.Before(r.CreatedAt) {
		return Record{}, ErrInvalidRecord
	}
	if r.State == Resolved {
		if r.ResolutionID == resolutionID && r.ResolutionHash == hash {
			return r, nil
		}
		return Record{}, ErrResolutionConflict
	}
	if r.State != Waiting {
		return Record{}, ErrAlreadySettled
	}
	if !r.Deadline.IsZero() && !now.Before(r.Deadline) {
		return Record{}, ErrAlreadySettled
	}
	r.State, r.Resolution, r.ResolutionHash, r.ResolutionID, r.ResolvedBy = Resolved, append([]byte(nil), resolution...), hash, resolutionID, actor
	r.ResolvedAt, r.UpdatedAt, r.Version = now, now, r.Version+1
	return r, nil
}

func (r Record) Expire(now time.Time) (Record, error) {
	if r.State != Waiting {
		return Record{}, ErrAlreadySettled
	}
	if r.Deadline.IsZero() || now.IsZero() || now.Before(r.Deadline) {
		return Record{}, ErrInvalidRecord
	}
	r.State, r.UpdatedAt, r.Version = Expired, now, r.Version+1
	return r, nil
}

func (r Record) Cancel(now time.Time) (Record, error) {
	if r.State != Waiting {
		return Record{}, ErrAlreadySettled
	}
	if now.IsZero() || now.Before(r.CreatedAt) {
		return Record{}, ErrInvalidRecord
	}
	r.State, r.UpdatedAt, r.Version = Cancelled, now, r.Version+1
	return r, nil
}
