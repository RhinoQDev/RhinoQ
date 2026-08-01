package rhinoq

import (
	"context"
	"encoding/json"
	"errors"
	"sync"
	"time"

	repairapp "github.com/madebyduy/RhinoQ/internal/application/repairs"
	"github.com/madebyduy/RhinoQ/internal/domain/finding"
	"github.com/madebyduy/RhinoQ/internal/domain/repair"
)

type RepairPreview struct{ Summary, Precondition string }
type RepairApplyResult struct{ Outcome string }
type RepairVerification struct {
	Passed   bool
	Evidence string
}
type RepairHandler interface {
	Preview(context.Context, FindingKey, json.RawMessage) (RepairPreview, error)
	Apply(context.Context, FindingKey, json.RawMessage, string) (RepairApplyResult, error)
	Verify(context.Context, FindingKey, json.RawMessage) (RepairVerification, error)
}
type RepairRegistry struct {
	mu       sync.RWMutex
	handlers map[string]RepairHandler
}

func NewRepairRegistry() *RepairRegistry {
	return &RepairRegistry{handlers: map[string]RepairHandler{}}
}
func (r *RepairRegistry) Register(name string, h RepairHandler) error {
	if name == "" || h == nil {
		return errors.New("repair name and handler are required")
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if _, ok := r.handlers[name]; ok {
		return errors.New("repair handler already registered")
	}
	r.handlers[name] = h
	return nil
}
func (r *RepairRegistry) handler(name string) (RepairHandler, error) {
	if r == nil {
		return nil, errors.New("repair registry is required")
	}
	r.mu.RLock()
	defer r.mu.RUnlock()
	h := r.handlers[name]
	if h == nil {
		return nil, errors.New("repair handler is not registered")
	}
	return h, nil
}

type RepairProposal struct {
	ID         string          `json:"id"`
	Finding    FindingKey      `json:"finding"`
	Handler    string          `json:"handler"`
	Parameters json.RawMessage `json:"parameters,omitempty"`
	Actor      string          `json:"actor"`
}
type RepairRecord struct {
	ID             string          `json:"id"`
	Finding        FindingKey      `json:"finding"`
	Handler        string          `json:"handler"`
	Parameters     json.RawMessage `json:"parameters"`
	State          string          `json:"state"`
	ProposedBy     string          `json:"proposedBy"`
	ApprovedBy     string          `json:"approvedBy,omitempty"`
	ApprovalReason string          `json:"approvalReason,omitempty"`
	Preview        string          `json:"preview,omitempty"`
	Precondition   string          `json:"precondition,omitempty"`
	Outcome        string          `json:"outcome,omitempty"`
	Version        int64           `json:"version"`
	CreatedAt      time.Time       `json:"createdAt"`
	UpdatedAt      time.Time       `json:"updatedAt"`
}

func (c *IntegrityClient) ProposeRepair(ctx context.Context, p RepairProposal) (RepairRecord, error) {
	s, e := c.repairService()
	if e != nil {
		return RepairRecord{}, e
	}
	r, e := s.Propose(ctx, repair.ID(p.ID), findingKey(p.Finding), p.Handler, p.Parameters, p.Actor)
	return publicRepair(r), e
}
func (c *IntegrityClient) PreviewRepair(ctx context.Context, id string, registry *RepairRegistry) (RepairRecord, error) {
	s, e := c.repairService()
	if e != nil {
		return RepairRecord{}, e
	}
	r, e := s.Get(ctx, repair.ID(id))
	if e != nil {
		return RepairRecord{}, e
	}
	h, e := registry.handler(r.Handler)
	if e != nil {
		return publicRepair(r), e
	}
	r, e = s.Preview(ctx, r.ID, repairHandlerAdapter{h})
	return publicRepair(r), e
}
func (c *IntegrityClient) ApproveRepair(ctx context.Context, id, actor, reason string) (RepairRecord, error) {
	s, e := c.repairService()
	if e != nil {
		return RepairRecord{}, e
	}
	r, e := s.Approve(ctx, repair.ID(id), actor, reason)
	return publicRepair(r), e
}
func (c *IntegrityClient) ExecuteRepair(ctx context.Context, id string, registry *RepairRegistry) (RepairRecord, error) {
	s, e := c.repairService()
	if e != nil {
		return RepairRecord{}, e
	}
	r, e := s.Get(ctx, repair.ID(id))
	if e != nil {
		return RepairRecord{}, e
	}
	h, e := registry.handler(r.Handler)
	if e != nil {
		return publicRepair(r), e
	}
	r, e = s.Execute(ctx, r.ID, repairHandlerAdapter{h})
	return publicRepair(r), e
}
func (c *IntegrityClient) repairService() (*repairapp.Service, error) {
	if c == nil || c.repairs == nil || c.findings == nil {
		return nil, errors.New("rhinoq repair workflow is not configured")
	}
	return repairapp.New(c.repairs, c.findings, nil)
}

type repairHandlerAdapter struct{ RepairHandler }

func (a repairHandlerAdapter) Preview(ctx context.Context, k finding.Key, p json.RawMessage) (repairapp.Preview, error) {
	r, e := a.RepairHandler.Preview(ctx, publicFindingKey(k), p)
	return repairapp.Preview{Summary: r.Summary, Precondition: r.Precondition}, e
}
func (a repairHandlerAdapter) Apply(ctx context.Context, k finding.Key, p json.RawMessage, token string) (repairapp.ApplyResult, error) {
	r, e := a.RepairHandler.Apply(ctx, publicFindingKey(k), p, token)
	return repairapp.ApplyResult{Outcome: r.Outcome}, e
}
func (a repairHandlerAdapter) Verify(ctx context.Context, k finding.Key, p json.RawMessage) (repairapp.Verification, error) {
	r, e := a.RepairHandler.Verify(ctx, publicFindingKey(k), p)
	return repairapp.Verification{Passed: r.Passed, Evidence: r.Evidence}, e
}
func publicRepair(r repair.Record) RepairRecord {
	return RepairRecord{ID: string(r.ID), Finding: publicFindingKey(r.FindingKey), Handler: r.Handler, Parameters: r.Parameters, State: string(r.State), ProposedBy: r.ProposedBy, ApprovedBy: r.ApprovedBy, ApprovalReason: r.ApprovalReason, Preview: r.Preview, Precondition: r.Precondition, Outcome: r.Outcome, Version: r.Version, CreatedAt: r.CreatedAt, UpdatedAt: r.UpdatedAt}
}
