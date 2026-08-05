package authz

import "strings"

// Role is a named bundle of permissions. RhinoQ ships a fixed set rather than
// letting a deployment define its own: a custom-role editor is a large surface
// whose first bug is a privilege escalation, and no adopter has asked for one.
// Adding a role here is a deliberate, reviewed change.
type Role string

const (
	// RoleOwner is the only role that can delete or rename the tenant itself.
	// Every tenant must keep at least one, which Membership enforcement checks.
	RoleOwner Role = "owner"
	// RoleAdmin runs the tenant day to day and manages who else is in it, but
	// cannot destroy the tenant. This is the difference that makes "remove the
	// admin who went rogue" a survivable event.
	RoleAdmin Role = "admin"
	// RoleOperator is the incident role: see everything, move queues, approve a
	// repair. It cannot change membership, so an operator cannot quietly grant
	// themselves a second identity to satisfy the different-approver rule.
	RoleOperator Role = "operator"
	// RoleDeveloper builds Rules and Tasks. It deliberately holds no Approve:
	// authoring the Rule that raises a Finding and approving the repair that
	// mutates business data on the strength of it is one person holding both
	// ends of the control.
	RoleDeveloper Role = "developer"
	// RoleViewer reads. It is the safe default for dashboards and on-call
	// bystanders.
	RoleViewer Role = "viewer"
	// RoleTaskOwner is an end-user credential, not a staff role. It is always
	// paired with an owner scope, so its Task permissions reach exactly the
	// Tasks that principal owns. Granting it without a scope is rejected.
	RoleTaskOwner Role = "task_owner"
)

// rolePermissions is the whole matrix. It is data, not code, so a test can
// assert properties over it — that viewer is a strict subset of operator, that
// only owner holds tenant:administer, that no role outside the admin pair can
// touch membership.
var rolePermissions = map[Role]map[Permission]bool{
	RoleOwner:     permissionSet(everyPermission()...),
	RoleAdmin:     permissionSet(adminPermissions()...),
	RoleOperator:  permissionSet(operatorPermissions()...),
	RoleDeveloper: permissionSet(developerPermissions()...),
	RoleViewer:    permissionSet(viewerPermissions()...),
	RoleTaskOwner: permissionSet(
		Permission{ResourceTask, ActionRead},
		Permission{ResourceTask, ActionWrite},
	),
}

func everyPermission() []Permission {
	permissions := make([]Permission, 0, len(Resources())*len(Actions()))
	for _, resource := range Resources() {
		for _, action := range Actions() {
			permissions = append(permissions, Permission{resource, action})
		}
	}
	return permissions
}

// adminPermissions is everything an owner has except the power to administer
// the tenant record itself.
func adminPermissions() []Permission {
	permissions := make([]Permission, 0, len(Resources())*len(Actions()))
	for _, permission := range everyPermission() {
		if permission.Resource == ResourceTenant && permission.Action == ActionAdminister {
			continue
		}
		permissions = append(permissions, permission)
	}
	return permissions
}

func operatorPermissions() []Permission {
	permissions := viewerPermissions()
	for _, resource := range []Resource{
		ResourceTask, ResourceJob, ResourceFinding, ResourceRule,
		ResourceRepair, ResourceProviderOperation, ResourceQueue,
	} {
		permissions = append(permissions,
			Permission{resource, ActionWrite},
			Permission{resource, ActionOperate},
		)
	}
	permissions = append(permissions, Permission{ResourceRepair, ActionApprove})
	return permissions
}

func developerPermissions() []Permission {
	permissions := viewerPermissions()
	for _, resource := range []Resource{
		ResourceTask, ResourceJob, ResourceRule, ResourceProviderOperation,
	} {
		permissions = append(permissions, Permission{resource, ActionWrite})
	}
	permissions = append(permissions, Permission{ResourceFinding, ActionWrite})
	return permissions
}

// viewerPermissions is read on everything the tenant owns except its own
// membership list: who else has access is an administrative fact, and leaking
// it turns a dashboard credential into reconnaissance.
func viewerPermissions() []Permission {
	permissions := make([]Permission, 0, len(Resources()))
	for _, resource := range Resources() {
		if resource == ResourceMembership {
			continue
		}
		permissions = append(permissions, Permission{resource, ActionRead})
	}
	return permissions
}

func permissionSet(permissions ...Permission) map[Permission]bool {
	set := make(map[Permission]bool, len(permissions))
	for _, permission := range permissions {
		set[permission] = true
	}
	return set
}

func (r Role) Valid() bool {
	_, known := rolePermissions[r]
	return known
}

// RequiresOwnerScope reports whether a role is meaningless — and unsafe —
// without a subject scope attached.
func (r Role) RequiresOwnerScope() bool { return r == RoleTaskOwner }

// Grants reports whether the role alone allows the permission. It answers the
// role gate only; it says nothing about which tenant the resource is in.
func (r Role) Grants(permission Permission) bool {
	return rolePermissions[r][permission]
}

// Permissions returns the role's grants in the stable order of Resources and
// Actions, for display in `rhinoq tenants roles` and in audit output.
func (r Role) Permissions() []Permission {
	granted := rolePermissions[r]
	permissions := make([]Permission, 0, len(granted))
	for _, resource := range Resources() {
		for _, action := range Actions() {
			permission := Permission{resource, action}
			if granted[permission] {
				permissions = append(permissions, permission)
			}
		}
	}
	return permissions
}

func ParseRole(raw string) (Role, bool) {
	role := Role(strings.ToLower(strings.TrimSpace(raw)))
	if !role.Valid() {
		return "", false
	}
	return role, true
}

// Roles returns every built-in role from most to least privileged. The order is
// relied on by tests asserting the subset relation between adjacent roles.
func Roles() []Role {
	return []Role{RoleOwner, RoleAdmin, RoleOperator, RoleDeveloper, RoleViewer, RoleTaskOwner}
}
