package authz

import (
	"fmt"
	"sort"
	"strings"
	"time"
)

// PrincipalKind separates a human from a machine because the two need
// different lifecycles: a human is deactivated when they leave, a service
// identity is rotated on a schedule and must never be a tenant's last owner.
type PrincipalKind string

const (
	PrincipalUser    PrincipalKind = "user"
	PrincipalService PrincipalKind = "service"
	// PrincipalEndUser is a customer of the adopter, not of RhinoQ. It exists
	// so a Task polling credential handed to a browser is a first-class,
	// always-scoped identity instead of an operator token with a smaller list.
	PrincipalEndUser PrincipalKind = "end_user"
)

func (k PrincipalKind) Valid() bool {
	return k == PrincipalUser || k == PrincipalService || k == PrincipalEndUser
}

// PrincipalID identifies an actor across tenants. A principal is not owned by
// a tenant — one person can belong to several — which is why membership is a
// separate record rather than a column here.
type PrincipalID string

func (id PrincipalID) String() string { return string(id) }

type Principal struct {
	ID          PrincipalID
	Kind        PrincipalKind
	DisplayName string
	Disabled    bool
	CreatedAt   time.Time
	UpdatedAt   time.Time
}

type PrincipalSpec struct {
	ID          PrincipalID
	Kind        PrincipalKind
	DisplayName string
	Now         time.Time
}

func NewPrincipal(spec PrincipalSpec) (Principal, error) {
	name := strings.TrimSpace(spec.DisplayName)
	if spec.ID == "" || name == "" || spec.Now.IsZero() {
		return Principal{}, fmt.Errorf("%w: id, display name and time are required", ErrInvalidPrincipal)
	}
	if !spec.Kind.Valid() {
		return Principal{}, fmt.Errorf("%w: %q is not a principal kind", ErrInvalidPrincipal, spec.Kind)
	}
	return Principal{
		ID: spec.ID, Kind: spec.Kind, DisplayName: name,
		CreatedAt: spec.Now, UpdatedAt: spec.Now,
	}, nil
}

// Membership binds a principal into one tenant with one role. One row per
// (principal, tenant): a principal with two roles in the same tenant would
// make "what can they do" a union that nobody can revoke in one action.
type Membership struct {
	PrincipalID PrincipalID
	TenantID    TenantID
	Role        Role
	// OwnerScope narrows the membership to resources carrying this owner id.
	// Empty means tenant-wide. It is the third gate: role and tenant can both
	// pass and a scoped membership still only reaches its own subjects.
	OwnerScope string
	CreatedAt  time.Time
	UpdatedAt  time.Time
}

type MembershipSpec struct {
	PrincipalID PrincipalID
	TenantID    TenantID
	Role        Role
	OwnerScope  string
	Now         time.Time
}

func NewMembership(spec MembershipSpec) (Membership, error) {
	scope := strings.TrimSpace(spec.OwnerScope)
	if spec.PrincipalID == "" || spec.TenantID == "" || spec.Now.IsZero() {
		return Membership{}, fmt.Errorf(
			"%w: principal, tenant and time are required", ErrInvalidMembership)
	}
	if !spec.Role.Valid() {
		return Membership{}, fmt.Errorf("%w: %q is not a role", ErrInvalidMembership, spec.Role)
	}
	// An unscoped task_owner would hold task:read and task:write across the
	// whole tenant — every customer's Task, from a credential meant for one
	// browser. Reject it at construction so no store can hold that row.
	if spec.Role.RequiresOwnerScope() && scope == "" {
		return Membership{}, fmt.Errorf(
			"%w: role %s requires an owner scope", ErrInvalidMembership, spec.Role)
	}
	return Membership{
		PrincipalID: spec.PrincipalID, TenantID: spec.TenantID,
		Role: spec.Role, OwnerScope: scope,
		CreatedAt: spec.Now, UpdatedAt: spec.Now,
	}, nil
}

func (m Membership) Valid() bool {
	if m.PrincipalID == "" || m.TenantID == "" || !m.Role.Valid() {
		return false
	}
	if m.Role.RequiresOwnerScope() && strings.TrimSpace(m.OwnerScope) == "" {
		return false
	}
	return !m.CreatedAt.IsZero() && !m.UpdatedAt.IsZero()
}

// TenantWide reports whether the membership reaches every subject in its
// tenant rather than one owner's.
func (m Membership) TenantWide() bool { return strings.TrimSpace(m.OwnerScope) == "" }

// CheckRoleChange guards the invariant that a tenant never loses its last
// owner. Losing it leaves a tenant nobody can administer, recoverable only by
// a database edit — which is precisely the operation this package exists to
// make unnecessary.
//
// currentOwners counts owner memberships in the tenant, including this one if
// it is currently an owner.
func (m Membership) CheckRoleChange(to Role, currentOwners int) error {
	if !to.Valid() {
		return fmt.Errorf("%w: %q is not a role", ErrInvalidMembership, to)
	}
	if to.RequiresOwnerScope() && m.TenantWide() {
		return fmt.Errorf("%w: role %s requires an owner scope", ErrInvalidMembership, to)
	}
	if m.Role == RoleOwner && to != RoleOwner && currentOwners <= 1 {
		return fmt.Errorf("%w: %s is the only owner of %s", ErrLastOwner, m.PrincipalID, m.TenantID)
	}
	return nil
}

// CheckRemoval applies the same last-owner rule to deletion.
func (m Membership) CheckRemoval(currentOwners int) error {
	if m.Role == RoleOwner && currentOwners <= 1 {
		return fmt.Errorf("%w: %s is the only owner of %s", ErrLastOwner, m.PrincipalID, m.TenantID)
	}
	return nil
}

// SortMemberships gives stores and API responses one deterministic order, so a
// membership list is diffable between calls and between replicas.
func SortMemberships(memberships []Membership) {
	sort.SliceStable(memberships, func(i, j int) bool {
		if memberships[i].TenantID != memberships[j].TenantID {
			return memberships[i].TenantID < memberships[j].TenantID
		}
		return memberships[i].PrincipalID < memberships[j].PrincipalID
	})
}
