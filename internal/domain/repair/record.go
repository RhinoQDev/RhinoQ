package repair

import (
	"encoding/json"
	"errors"
	"strings"
	"time"

	"github.com/madebyduy/RhinoQ/internal/domain/finding"
)

type State string

const (
	Proposed  State = "proposed"
	Previewed State = "previewed"
	Approved  State = "approved"
	Running   State = "running"
	Succeeded State = "succeeded"
	Failed    State = "failed"
	Stale     State = "stale"
	Uncertain State = "uncertain"
)

type ID string
type Record struct {
	ID             ID
	FindingKey     finding.Key
	Handler        string
	Parameters     json.RawMessage
	State          State
	ProposedBy     string
	ApprovedBy     string
	ApprovalReason string
	Preview        string
	Precondition   string
	Outcome        string
	Version        int64
	CreatedAt      time.Time
	UpdatedAt      time.Time
}

var ErrInvalid = errors.New("invalid repair plan")
var ErrTransition = errors.New("invalid repair transition")
var ErrFourEyes = errors.New("repair approver must differ from proposer")

func New(id ID, key finding.Key, handler string, parameters json.RawMessage, actor string, now time.Time) (Record, error) {
	if id == "" || key.Validate() != nil || strings.TrimSpace(handler) == "" ||
		strings.TrimSpace(actor) == "" || now.IsZero() || !json.Valid(parameters) {
		return Record{}, ErrInvalid
	}
	return Record{ID: id, FindingKey: key, Handler: handler, Parameters: append(json.RawMessage(nil), parameters...),
		State: Proposed, ProposedBy: actor, Version: 1, CreatedAt: now, UpdatedAt: now}, nil
}
func (r Record) SetPreview(summary, precondition string, now time.Time) (Record, error) {
	if (r.State != Proposed && r.State != Previewed) || strings.TrimSpace(summary) == "" || strings.TrimSpace(precondition) == "" || now.IsZero() {
		return r, ErrTransition
	}
	if r.State == Previewed && r.Preview == summary && r.Precondition == precondition {
		return r, nil
	}
	r.State, r.Preview, r.Precondition, r.Version, r.UpdatedAt = Previewed, summary, precondition, r.Version+1, now
	return r, nil
}
func (r Record) Approve(actor, reason string, now time.Time) (Record, error) {
	if r.State != Previewed || strings.TrimSpace(actor) == "" || strings.TrimSpace(reason) == "" || now.IsZero() {
		return r, ErrTransition
	}
	if actor == r.ProposedBy {
		return r, ErrFourEyes
	}
	r.State, r.ApprovedBy, r.ApprovalReason, r.Version, r.UpdatedAt = Approved, actor, reason, r.Version+1, now
	return r, nil
}
func (r Record) Start(now time.Time) (Record, error) { return r.move(Approved, Running, "", now) }
func (r Record) Finish(state State, outcome string, now time.Time) (Record, error) {
	if state != Succeeded && state != Failed && state != Stale && state != Uncertain {
		return r, ErrTransition
	}
	return r.move(Running, state, outcome, now)
}

func (r Record) Abort(reason string, now time.Time) (Record, error) {
	return r.move(Proposed, Failed, reason, now)
}
func (r Record) move(from, to State, outcome string, now time.Time) (Record, error) {
	if r.State != from || now.IsZero() {
		return r, ErrTransition
	}
	r.State, r.Outcome, r.Version, r.UpdatedAt = to, outcome, r.Version+1, now
	return r, nil
}
