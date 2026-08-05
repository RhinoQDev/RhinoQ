package authz

import "strings"

// Subject is one authenticated identity acting inside one tenant for the
// duration of one request. It is the resolved join of a credential, its
// principal and that principal's membership — resolved once at the edge, never
// re-derived inside a handler.
type Subject struct {
	PrincipalID  PrincipalID
	Kind         PrincipalKind
	TenantID     TenantID
	Role         Role
	OwnerScope   string
	TenantStatus TenantStatus
	Disabled     bool
}

// SubjectFromMembership builds the per-request subject. Tenant status and the
// principal's disabled flag travel with it so a suspended tenant or a revoked
// person is denied by the same evaluation as a missing permission, rather than
// by a check somebody has to remember to add.
func SubjectFromMembership(principal Principal, membership Membership, status TenantStatus) Subject {
	return Subject{
		PrincipalID:  principal.ID,
		Kind:         principal.Kind,
		TenantID:     membership.TenantID,
		Role:         membership.Role,
		OwnerScope:   membership.OwnerScope,
		TenantStatus: status,
		Disabled:     principal.Disabled,
	}
}

// TenantWide reports whether the subject reaches every owner in its tenant.
func (s Subject) TenantWide() bool { return strings.TrimSpace(s.OwnerScope) == "" }

// Target describes the resource being acted on.
//
// TenantID is empty only for a creation, where no row exists yet; Authorize
// treats that as "inherits the subject's tenant" and never as "matches any
// tenant". OwnerID is empty for resources that have no owner, such as a queue.
type Target struct {
	TenantID TenantID
	OwnerID  string
	// Creating marks a call that will bring the resource into existence. It is
	// separate from an empty TenantID so a bug that drops the tenant on a read
	// cannot be mistaken for a create and silently allowed.
	Creating bool
}

// Reason names why a decision came out the way it did. It is recorded in the
// audit trail and drives the status code, so it is an enumeration rather than
// a free-text message.
type Reason string

const (
	ReasonAllowed          Reason = "allowed"
	ReasonPrincipalRevoked Reason = "principal_revoked"
	ReasonTenantSuspended  Reason = "tenant_suspended"
	ReasonTenantMismatch   Reason = "tenant_mismatch"
	ReasonOutOfScope       Reason = "out_of_scope"
	ReasonRoleLacks        Reason = "role_lacks_permission"
	ReasonMalformed        Reason = "malformed_request"
)

type Decision struct {
	Allowed    bool
	Reason     Reason
	Permission Permission
	Subject    Subject
	Target     Target
}

// Conceal reports whether the caller must answer as though the resource does
// not exist instead of admitting it is forbidden.
//
// A tenant mismatch or an out-of-scope subject must be concealed: answering
// 403 for a resource in another tenant and 404 for an id that was never issued
// turns any endpoint into an oracle for "does tenant B have a Task with this
// id", which is the isolation boundary leaking one bit at a time. A role
// denial inside the subject's own tenant is safe to state plainly — the
// subject can already see that the resource exists — and saying so is the
// difference between an operator fixing their role and filing a bug.
func (d Decision) Conceal() bool {
	return !d.Allowed &&
		(d.Reason == ReasonTenantMismatch || d.Reason == ReasonOutOfScope)
}

// Authorize is the single decision point. Every gate is evaluated in order of
// how much it reveals: identity, then tenant, then scope, then role.
func Authorize(subject Subject, permission Permission, target Target) Decision {
	deny := func(reason Reason) Decision {
		return Decision{Reason: reason, Permission: permission, Subject: subject, Target: target}
	}

	if !permission.Valid() || subject.PrincipalID == "" || subject.TenantID == "" ||
		!subject.Role.Valid() {
		return deny(ReasonMalformed)
	}
	// A target that is neither bound to a tenant nor a creation is a caller bug
	// — most likely a lookup that forgot to load the row's tenant. Failing
	// closed here is what stops that bug from becoming a tenant-wide read.
	if target.TenantID == "" && !target.Creating {
		return deny(ReasonMalformed)
	}
	if subject.Disabled {
		return deny(ReasonPrincipalRevoked)
	}
	// A suspended tenant keeps its evidence readable. Suspension is a billing
	// or trust action, and destroying the ability to read Findings during it
	// would punish the investigation as well as the account.
	if subject.TenantStatus == TenantSuspended && permission.Action != ActionRead {
		return deny(ReasonTenantSuspended)
	}

	// Tenant gate. There is no wildcard and no superuser tenant — an operator
	// of the system tenant is an operator of that tenant only.
	//
	// Creating relaxes exactly one thing: an unbound target inherits the
	// subject's tenant. A creation that names a tenant is still compared, so
	// "create this in tenant B" cannot be smuggled through by setting the
	// flag. The two conditions are separate because collapsing them into
	// `!target.Creating &&` is precisely the hole this comment is above.
	if target.TenantID != "" && target.TenantID != subject.TenantID {
		return deny(ReasonTenantMismatch)
	}

	// Scope gate. A scoped subject reaches only its own subjects, and a
	// creation it makes must be owned by itself: otherwise a browser credential
	// could mint Tasks belonging to another customer inside the same tenant.
	if !subject.TenantWide() {
		if target.OwnerID == "" || target.OwnerID != subject.OwnerScope {
			return deny(ReasonOutOfScope)
		}
	}

	// Role gate, evaluated last: by this point the subject is entitled to know
	// the resource exists, so the denial can be honest about being a
	// permission problem.
	if !subject.Role.Grants(permission) {
		return deny(ReasonRoleLacks)
	}

	return Decision{
		Allowed: true, Reason: ReasonAllowed, Permission: permission,
		Subject: subject, Target: target,
	}
}
