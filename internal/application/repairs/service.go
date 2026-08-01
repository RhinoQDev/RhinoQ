package repairs

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/madebyduy/RhinoQ/internal/domain/finding"
	"github.com/madebyduy/RhinoQ/internal/domain/repair"
	"github.com/madebyduy/RhinoQ/internal/ports"
)

type Preview struct{ Summary, Precondition string }
type ApplyResult struct{ Outcome string }
type Verification struct {
	Passed   bool
	Evidence string
}
type Handler interface {
	Preview(context.Context, finding.Key, json.RawMessage) (Preview, error)
	Apply(context.Context, finding.Key, json.RawMessage, string) (ApplyResult, error)
	Verify(context.Context, finding.Key, json.RawMessage) (Verification, error)
}

type Service struct {
	repairs  ports.RepairStore
	findings ports.FindingStore
	now      func() time.Time
}

func New(repairs ports.RepairStore, findings ports.FindingStore, now func() time.Time) (*Service, error) {
	if repairs == nil || findings == nil {
		return nil, errors.New("repair and finding stores are required")
	}
	if now == nil {
		now = func() time.Time { return time.Now().UTC() }
	}
	return &Service{repairs: repairs, findings: findings, now: now}, nil
}
func (s *Service) Propose(ctx context.Context, id repair.ID, key finding.Key, handler string, parameters json.RawMessage, actor string) (repair.Record, error) {
	current, found, err := s.findings.GetFinding(ctx, key)
	if err != nil {
		return repair.Record{}, err
	}
	if !found {
		return repair.Record{}, ports.ErrFindingNotFound
	}
	transition := finding.Transition{Status: finding.RepairProposed, Actor: actor, Reason: "repair plan " + string(id) + " proposed", At: s.now()}
	if _, err := finding.ApplyTransition(current, transition); err != nil {
		return repair.Record{}, err
	}
	r, err := repair.New(id, key, handler, parameters, actor, s.now())
	if err != nil {
		return r, err
	}
	r, err = s.repairs.CreateRepair(ctx, r)
	if err != nil {
		return r, err
	}
	_, err = s.findings.TransitionFinding(ctx, key, transition)
	if err != nil {
		aborted, abortErr := r.Abort("finding changed before proposal committed", s.now())
		if abortErr == nil {
			_, abortErr = s.repairs.SaveRepair(ctx, aborted, r.Version)
		}
		return r, errors.Join(err, abortErr)
	}
	return r, nil
}
func (s *Service) Get(ctx context.Context, id repair.ID) (repair.Record, error) {
	r, found, err := s.repairs.GetRepair(ctx, id)
	if err != nil {
		return r, err
	}
	if !found {
		return r, ports.ErrRepairNotFound
	}
	return r, nil
}
func (s *Service) Preview(ctx context.Context, id repair.ID, h Handler) (repair.Record, error) {
	r, e := s.Get(ctx, id)
	if e != nil {
		return r, e
	}
	if e = s.ensureFinding(ctx, r, finding.RepairProposed); e != nil {
		return r, e
	}
	p, e := h.Preview(ctx, r.FindingKey, r.Parameters)
	if e != nil {
		return r, e
	}
	n, e := r.SetPreview(p.Summary, p.Precondition, s.now())
	if e != nil {
		return r, e
	}
	if n.Version == r.Version {
		return r, nil
	}
	return s.repairs.SaveRepair(ctx, n, r.Version)
}
func (s *Service) Approve(ctx context.Context, id repair.ID, actor, reason string) (repair.Record, error) {
	r, e := s.Get(ctx, id)
	if e != nil {
		return r, e
	}
	if e = s.ensureFinding(ctx, r, finding.RepairProposed); e != nil {
		return r, e
	}
	n, e := r.Approve(actor, reason, s.now())
	if e != nil {
		return r, e
	}
	return s.repairs.SaveRepair(ctx, n, r.Version)
}
func (s *Service) Execute(ctx context.Context, id repair.ID, h Handler) (repair.Record, error) {
	r, e := s.Get(ctx, id)
	if e != nil {
		return r, e
	}
	if e = s.ensureFinding(ctx, r, finding.RepairProposed); e != nil {
		return r, e
	}
	p, e := h.Preview(ctx, r.FindingKey, r.Parameters)
	if e != nil {
		return r, e
	}
	running, e := r.Start(s.now())
	if e != nil {
		return r, e
	}
	running, e = s.repairs.SaveRepair(ctx, running, r.Version)
	if e != nil {
		return r, e
	}
	_, _ = s.findings.TransitionFinding(ctx, r.FindingKey, finding.Transition{Status: finding.Repairing, Actor: r.ApprovedBy, Reason: r.ApprovalReason, At: s.now()})
	finish := func(state repair.State, outcome string) (repair.Record, error) {
		n, moveErr := running.Finish(state, outcome, s.now())
		if moveErr != nil {
			return running, moveErr
		}
		return s.repairs.SaveRepair(ctx, n, running.Version)
	}
	if p.Precondition != r.Precondition {
		final, saveErr := finish(repair.Stale, "precondition changed; create a new plan")
		_, transitionErr := s.findings.TransitionFinding(ctx, r.FindingKey, finding.Transition{Status: finding.Acknowledged, Actor: r.ApprovedBy, Reason: "repair plan became stale; create a new plan", At: s.now()})
		return final, errors.Join(saveErr, transitionErr)
	}
	applied, e := h.Apply(ctx, r.FindingKey, r.Parameters, string(r.ID))
	if e != nil {
		final, saveErr := finish(repair.Uncertain, e.Error())
		_, transitionErr := s.findings.TransitionFinding(ctx, r.FindingKey, finding.Transition{Status: finding.Acknowledged, Actor: r.ApprovedBy, Reason: "repair result uncertain; reconcile before retry", At: s.now()})
		return final, errors.Join(e, saveErr, transitionErr)
	}
	verified, e := h.Verify(ctx, r.FindingKey, r.Parameters)
	if e != nil {
		final, saveErr := finish(repair.Uncertain, e.Error())
		_, transitionErr := s.findings.TransitionFinding(ctx, r.FindingKey, finding.Transition{Status: finding.Acknowledged, Actor: r.ApprovedBy, Reason: "repair verification unavailable; reconcile before retry", At: s.now()})
		return final, errors.Join(e, saveErr, transitionErr)
	}
	if !verified.Passed {
		final, saveErr := finish(repair.Failed, verified.Evidence)
		_, _ = s.findings.TransitionFinding(ctx, r.FindingKey, finding.Transition{Status: finding.Acknowledged, Actor: r.ApprovedBy, Reason: "repair verification failed: " + verified.Evidence, At: s.now()})
		return final, saveErr
	}
	final, e := finish(repair.Succeeded, applied.Outcome+"; verified: "+verified.Evidence)
	if e == nil {
		_, e = s.findings.TransitionFinding(ctx, r.FindingKey, finding.Transition{Status: finding.Resolved, Actor: r.ApprovedBy, Reason: "repair verified: " + verified.Evidence, At: s.now()})
	}
	return final, e
}

func (s *Service) ensureFinding(ctx context.Context, record repair.Record, expected finding.Status) error {
	current, found, err := s.findings.GetFinding(ctx, record.FindingKey)
	if err != nil {
		return err
	}
	if !found {
		return ports.ErrFindingNotFound
	}
	if current.Status != expected {
		return errors.New("finding state no longer permits this repair step")
	}
	return nil
}
