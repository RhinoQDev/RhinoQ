package authz

import (
	"testing"
	"time"
)

var now = time.Date(2026, 8, 5, 12, 0, 0, 0, time.UTC)

func subject(tenant TenantID, role Role) Subject {
	return Subject{
		PrincipalID: "prn_a", Kind: PrincipalUser, TenantID: tenant,
		Role: role, TenantStatus: TenantActive,
	}
}

func scoped(tenant TenantID, owner string) Subject {
	s := subject(tenant, RoleTaskOwner)
	s.Kind = PrincipalEndUser
	s.OwnerScope = owner
	return s
}

func target(tenant TenantID, owner string) Target {
	return Target{TenantID: tenant, OwnerID: owner}
}

// The tenant gate is the one this package exists for, so it is tested against
// the most privileged role there is: if owner of A can reach B, nothing else
// in the matrix matters.
func TestOwnerOfOneTenantCannotReachAnother(t *testing.T) {
	for _, permission := range everyPermission() {
		decision := Authorize(subject("tnt_a", RoleOwner), permission, target("tnt_b", ""))
		if decision.Allowed {
			t.Fatalf("owner of tnt_a allowed %s in tnt_b", permission)
		}
		if decision.Reason != ReasonTenantMismatch {
			t.Fatalf("%s: reason = %s, want %s", permission, decision.Reason, ReasonTenantMismatch)
		}
		if !decision.Conceal() {
			t.Fatalf("%s: cross-tenant denial must be concealed as not-found", permission)
		}
	}
}

// A denial inside the subject's own tenant must stay legible: concealing it
// would make a misconfigured role indistinguishable from a deleted resource.
func TestRoleDenialInOwnTenantIsNotConcealed(t *testing.T) {
	decision := Authorize(subject("tnt_a", RoleViewer),
		Permission{ResourceRepair, ActionApprove}, target("tnt_a", ""))
	if decision.Allowed {
		t.Fatal("viewer approved a repair")
	}
	if decision.Reason != ReasonRoleLacks {
		t.Fatalf("reason = %s, want %s", decision.Reason, ReasonRoleLacks)
	}
	if decision.Conceal() {
		t.Fatal("same-tenant role denial must not be concealed")
	}
}

// The gates are independent. Sharing a tenant is not permission, and holding
// permission is not tenancy.
func TestGatesAreIndependent(t *testing.T) {
	permission := Permission{ResourceRepair, ActionApprove}
	sameTenantNoRole := Authorize(subject("tnt_a", RoleViewer), permission, target("tnt_a", ""))
	roleNoTenant := Authorize(subject("tnt_a", RoleOperator), permission, target("tnt_b", ""))
	both := Authorize(subject("tnt_a", RoleOperator), permission, target("tnt_a", ""))

	if sameTenantNoRole.Allowed || roleNoTenant.Allowed {
		t.Fatal("one gate alone allowed the call")
	}
	if !both.Allowed {
		t.Fatalf("both gates passed but decision was %s", both.Reason)
	}
}

// A target with no tenant and no creation flag is a caller that forgot to load
// the row. It must fail closed rather than fall through the tenant comparison.
func TestUnboundTargetFailsClosed(t *testing.T) {
	decision := Authorize(subject("tnt_a", RoleOwner),
		Permission{ResourceTask, ActionRead}, Target{})
	if decision.Allowed {
		t.Fatal("a target with no tenant was allowed")
	}
	if decision.Reason != ReasonMalformed {
		t.Fatalf("reason = %s, want %s", decision.Reason, ReasonMalformed)
	}
}

func TestCreationBindsToSubjectTenant(t *testing.T) {
	decision := Authorize(subject("tnt_a", RoleDeveloper),
		Permission{ResourceTask, ActionWrite}, Target{Creating: true})
	if !decision.Allowed {
		t.Fatalf("developer could not create in own tenant: %s", decision.Reason)
	}
}

// Creating is not a bypass: naming another tenant explicitly is still a
// mismatch even on a create.
func TestCreationCannotNameAnotherTenant(t *testing.T) {
	decision := Authorize(subject("tnt_a", RoleOwner),
		Permission{ResourceTask, ActionWrite},
		Target{TenantID: "tnt_b", Creating: true})
	if decision.Allowed {
		t.Fatal("a create named another tenant and was allowed")
	}
}

func TestScopedSubjectReachesOnlyItsOwnSubjects(t *testing.T) {
	permission := Permission{ResourceTask, ActionRead}
	own := Authorize(scoped("tnt_a", "user-1"), permission, target("tnt_a", "user-1"))
	if !own.Allowed {
		t.Fatalf("scoped subject denied its own task: %s", own.Reason)
	}

	other := Authorize(scoped("tnt_a", "user-1"), permission, target("tnt_a", "user-2"))
	if other.Allowed {
		t.Fatal("scoped subject read another owner's task in the same tenant")
	}
	if other.Reason != ReasonOutOfScope || !other.Conceal() {
		t.Fatalf("reason = %s conceal = %v, want out_of_scope concealed",
			other.Reason, other.Conceal())
	}

	// An unowned resource is not a free-for-all for a scoped subject.
	unowned := Authorize(scoped("tnt_a", "user-1"), permission, target("tnt_a", ""))
	if unowned.Allowed {
		t.Fatal("scoped subject reached a resource with no owner")
	}
}

// A scoped credential creating a Task must own what it creates, or a browser
// token becomes a way to plant work under another customer's name.
func TestScopedCreationMustBeSelfOwned(t *testing.T) {
	permission := Permission{ResourceTask, ActionWrite}
	foreign := Authorize(scoped("tnt_a", "user-1"), permission,
		Target{Creating: true, OwnerID: "user-2"})
	if foreign.Allowed {
		t.Fatal("scoped subject created a task owned by somebody else")
	}
	own := Authorize(scoped("tnt_a", "user-1"), permission,
		Target{Creating: true, OwnerID: "user-1"})
	if !own.Allowed {
		t.Fatalf("scoped subject could not create its own task: %s", own.Reason)
	}
}

func TestSuspendedTenantKeepsReadsAndStopsMutations(t *testing.T) {
	s := subject("tnt_a", RoleOwner)
	s.TenantStatus = TenantSuspended

	read := Authorize(s, Permission{ResourceFinding, ActionRead}, target("tnt_a", ""))
	if !read.Allowed {
		t.Fatalf("suspended tenant lost read access: %s", read.Reason)
	}
	for _, action := range []Action{ActionWrite, ActionOperate, ActionApprove, ActionAdminister} {
		decision := Authorize(s, Permission{ResourceFinding, action}, target("tnt_a", ""))
		if action == ActionAdminister {
			decision = Authorize(s, Permission{ResourceTenant, action}, target("tnt_a", ""))
		}
		if decision.Allowed {
			t.Fatalf("suspended tenant still allowed %s", action)
		}
		if decision.Reason != ReasonTenantSuspended {
			t.Fatalf("%s: reason = %s, want %s", action, decision.Reason, ReasonTenantSuspended)
		}
	}
}

// A revoked principal is denied before the tenant is even compared, so
// deactivating somebody does not depend on every membership being deleted.
func TestRevokedPrincipalIsDeniedEverywhere(t *testing.T) {
	s := subject("tnt_a", RoleOwner)
	s.Disabled = true
	decision := Authorize(s, Permission{ResourceTask, ActionRead}, target("tnt_a", ""))
	if decision.Allowed {
		t.Fatal("a disabled principal was allowed")
	}
	if decision.Reason != ReasonPrincipalRevoked {
		t.Fatalf("reason = %s, want %s", decision.Reason, ReasonPrincipalRevoked)
	}
}

func TestUnknownPermissionIsRejectedNotIgnored(t *testing.T) {
	decision := Authorize(subject("tnt_a", RoleOwner),
		Permission{Resource("secrets"), ActionRead}, target("tnt_a", ""))
	if decision.Allowed {
		t.Fatal("an unknown resource was allowed")
	}
	if decision.Reason != ReasonMalformed {
		t.Fatalf("reason = %s, want %s", decision.Reason, ReasonMalformed)
	}
}

func TestZeroSubjectIsDenied(t *testing.T) {
	decision := Authorize(Subject{}, Permission{ResourceTask, ActionRead}, target("tnt_a", ""))
	if decision.Allowed {
		t.Fatal("the zero subject was allowed")
	}
}
