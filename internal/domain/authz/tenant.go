package authz

import (
	"errors"
	"fmt"
	"regexp"
	"strings"
	"time"
)

var (
	ErrInvalidTenant     = errors.New("invalid tenant")
	ErrInvalidPrincipal  = errors.New("invalid principal")
	ErrInvalidMembership = errors.New("invalid membership")
	ErrLastOwner         = errors.New("tenant must keep at least one owner")
)

// TenantID is the isolation boundary. Every tenant-owned row carries one and
// every authorization decision compares one, so it is a distinct type: a
// string parameter in the wrong position is the exact mistake that produces a
// cross-tenant read, and the compiler should catch it instead of a test.
type TenantID string

func (id TenantID) String() string { return string(id) }

// SystemTenant is the tenant that pre-RBAC rows are backfilled into by
// migration 026. It is a real tenant with real members, not a wildcard: no
// code path treats it as able to see other tenants. Naming it makes the
// upgrade auditable — "which rows existed before isolation" is a query.
const SystemTenant TenantID = "tnt_system"

// TenantStatus gates access without deleting evidence. A suspended tenant
// still holds its Findings and audit history, which a deleted one would not.
type TenantStatus string

const (
	TenantActive    TenantStatus = "active"
	TenantSuspended TenantStatus = "suspended"
)

func (s TenantStatus) Valid() bool {
	return s == TenantActive || s == TenantSuspended
}

// slugPattern is deliberately narrow. Tenant slugs appear in URLs, log lines
// and PostgreSQL role names; allowing punctuation invites an injection whose
// blast radius is the isolation boundary itself.
var slugPattern = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$`)

type Tenant struct {
	ID        TenantID
	Slug      string
	Name      string
	Status    TenantStatus
	CreatedAt time.Time
	UpdatedAt time.Time
}

type TenantSpec struct {
	ID   TenantID
	Slug string
	Name string
	Now  time.Time
}

func NewTenant(spec TenantSpec) (Tenant, error) {
	slug := strings.ToLower(strings.TrimSpace(spec.Slug))
	name := strings.TrimSpace(spec.Name)
	if spec.ID == "" || name == "" || spec.Now.IsZero() {
		return Tenant{}, fmt.Errorf("%w: id, name and time are required", ErrInvalidTenant)
	}
	if !slugPattern.MatchString(slug) {
		return Tenant{}, fmt.Errorf(
			"%w: slug %q must be 3-64 lowercase letters, digits or hyphens and start and end alphanumeric",
			ErrInvalidTenant, spec.Slug)
	}
	return Tenant{
		ID:        spec.ID,
		Slug:      slug,
		Name:      name,
		Status:    TenantActive,
		CreatedAt: spec.Now,
		UpdatedAt: spec.Now,
	}, nil
}

func (t Tenant) Suspend(now time.Time) (Tenant, error) {
	if now.IsZero() {
		return t, fmt.Errorf("%w: time is required", ErrInvalidTenant)
	}
	t.Status = TenantSuspended
	t.UpdatedAt = now
	return t, nil
}

func (t Tenant) Reinstate(now time.Time) (Tenant, error) {
	if now.IsZero() {
		return t, fmt.Errorf("%w: time is required", ErrInvalidTenant)
	}
	t.Status = TenantActive
	t.UpdatedAt = now
	return t, nil
}

func (t Tenant) Valid() bool {
	return t.ID != "" && slugPattern.MatchString(t.Slug) &&
		strings.TrimSpace(t.Name) != "" && t.Status.Valid() &&
		!t.CreatedAt.IsZero() && !t.UpdatedAt.IsZero()
}
