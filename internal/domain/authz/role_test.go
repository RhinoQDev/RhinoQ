package authz

import (
	"errors"
	"testing"
)

// Only owner may administer the tenant record. If this ever widens, "remove
// the admin who went rogue" stops being survivable.
func TestOnlyOwnerAdministersTheTenant(t *testing.T) {
	permission := Permission{ResourceTenant, ActionAdminister}
	for _, role := range Roles() {
		granted := role.Grants(permission)
		if role == RoleOwner && !granted {
			t.Fatal("owner cannot administer the tenant")
		}
		if role != RoleOwner && granted {
			t.Fatalf("role %s can administer the tenant", role)
		}
	}
}

// Viewer must be a strict subset of operator, and operator of admin. A role
// matrix where a lower role holds something a higher one does not is a bug
// that only shows up as a confusing denial in an incident.
func TestRolesAreNested(t *testing.T) {
	pairs := []struct{ lower, higher Role }{
		{RoleViewer, RoleOperator},
		{RoleViewer, RoleDeveloper},
		{RoleOperator, RoleAdmin},
		{RoleDeveloper, RoleAdmin},
		{RoleAdmin, RoleOwner},
	}
	for _, pair := range pairs {
		for _, permission := range pair.lower.Permissions() {
			if !pair.higher.Grants(permission) {
				t.Fatalf("%s holds %s but %s does not", pair.lower, permission, pair.higher)
			}
		}
	}
}

// The separation that matters most: whoever authors the Rule that raises a
// Finding must not also be able to approve the repair it justifies.
func TestDeveloperCannotApproveRepairs(t *testing.T) {
	if !RoleDeveloper.Grants(Permission{ResourceRule, ActionWrite}) {
		t.Fatal("developer cannot write rules")
	}
	if RoleDeveloper.Grants(Permission{ResourceRepair, ActionApprove}) {
		t.Fatal("developer can approve repairs")
	}
}

// An operator that could edit membership could grant itself a second identity
// and satisfy the different-approver rule alone.
func TestOperatorCannotChangeMembership(t *testing.T) {
	for _, action := range Actions() {
		if RoleOperator.Grants(Permission{ResourceMembership, action}) {
			t.Fatalf("operator can %s membership", action)
		}
	}
}

// Who else has access is administrative. A dashboard credential should not be
// able to enumerate the staff list.
func TestViewerCannotReadMembership(t *testing.T) {
	if RoleViewer.Grants(Permission{ResourceMembership, ActionRead}) {
		t.Fatal("viewer can read membership")
	}
}

// The end-user credential must stay tiny. This test fails the moment somebody
// widens it, which is the point.
func TestTaskOwnerHoldsOnlyItsTaskPermissions(t *testing.T) {
	want := map[Permission]bool{
		{ResourceTask, ActionRead}:  true,
		{ResourceTask, ActionWrite}: true,
	}
	for _, permission := range everyPermission() {
		if RoleTaskOwner.Grants(permission) != want[permission] {
			t.Fatalf("task_owner grant of %s = %v, want %v",
				permission, RoleTaskOwner.Grants(permission), want[permission])
		}
	}
}

func TestTaskOwnerMembershipRequiresScope(t *testing.T) {
	_, err := NewMembership(MembershipSpec{
		PrincipalID: "prn_a", TenantID: "tnt_a", Role: RoleTaskOwner, Now: now,
	})
	if !errors.Is(err, ErrInvalidMembership) {
		t.Fatalf("unscoped task_owner membership was accepted: %v", err)
	}

	membership, err := NewMembership(MembershipSpec{
		PrincipalID: "prn_a", TenantID: "tnt_a", Role: RoleTaskOwner,
		OwnerScope: "user-1", Now: now,
	})
	if err != nil {
		t.Fatalf("scoped task_owner membership rejected: %v", err)
	}
	if membership.TenantWide() {
		t.Fatal("a scoped membership reported itself tenant-wide")
	}
}

func TestTenantKeepsItsLastOwner(t *testing.T) {
	membership, err := NewMembership(MembershipSpec{
		PrincipalID: "prn_a", TenantID: "tnt_a", Role: RoleOwner, Now: now,
	})
	if err != nil {
		t.Fatalf("owner membership rejected: %v", err)
	}
	if err := membership.CheckRoleChange(RoleViewer, 1); !errors.Is(err, ErrLastOwner) {
		t.Fatalf("demoting the last owner was allowed: %v", err)
	}
	if err := membership.CheckRemoval(1); !errors.Is(err, ErrLastOwner) {
		t.Fatalf("removing the last owner was allowed: %v", err)
	}
	if err := membership.CheckRoleChange(RoleViewer, 2); err != nil {
		t.Fatalf("demoting one of two owners was refused: %v", err)
	}
}

// A role change into task_owner on a tenant-wide membership would silently
// widen an end-user grant to the whole tenant.
func TestRoleChangeIntoScopedRoleNeedsScope(t *testing.T) {
	membership, _ := NewMembership(MembershipSpec{
		PrincipalID: "prn_a", TenantID: "tnt_a", Role: RoleViewer, Now: now,
	})
	if err := membership.CheckRoleChange(RoleTaskOwner, 2); !errors.Is(err, ErrInvalidMembership) {
		t.Fatalf("tenant-wide membership became a task_owner: %v", err)
	}
}

func TestParseRoleAndPermissionRejectUnknownNames(t *testing.T) {
	if _, ok := ParseRole("superuser"); ok {
		t.Fatal("an unknown role parsed")
	}
	if _, ok := ParseRole("OWNER"); !ok {
		t.Fatal("a known role failed to parse case-insensitively")
	}
	for _, raw := range []string{"", "task", "task:", ":read", "secrets:read", "task:destroy"} {
		if _, ok := ParsePermission(raw); ok {
			t.Fatalf("%q parsed as a permission", raw)
		}
	}
	if permission, ok := ParsePermission(" task:read "); !ok ||
		permission != (Permission{ResourceTask, ActionRead}) {
		t.Fatalf("a valid permission failed to parse: %v %v", permission, ok)
	}
}

func TestTenantSlugIsNarrow(t *testing.T) {
	for _, slug := range []string{"a", "ab", "-abc", "abc-", "AB_C", "a b", "acme'; DROP", ""} {
		if _, err := NewTenant(TenantSpec{
			ID: "tnt_a", Slug: slug, Name: "Acme", Now: now,
		}); !errors.Is(err, ErrInvalidTenant) {
			t.Fatalf("slug %q was accepted", slug)
		}
	}
	tenant, err := NewTenant(TenantSpec{ID: "tnt_a", Slug: "Acme-Co", Name: "Acme", Now: now})
	if err != nil {
		t.Fatalf("a valid slug was rejected: %v", err)
	}
	if tenant.Slug != "acme-co" {
		t.Fatalf("slug = %q, want normalised to lowercase", tenant.Slug)
	}
	if tenant.Status != TenantActive {
		t.Fatalf("new tenant status = %q", tenant.Status)
	}
}
