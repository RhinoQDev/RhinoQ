// Package authz is the tenant isolation and role authority for RhinoQ.
//
// It exists because the previous model — one operator token plus a list of
// per-owner Task credentials — has no concept of a tenant at all. Owner
// scoping was applied by calling taskVisibleTo at each handler that happened
// to remember, which makes every new route a chance to leak. This package
// moves the decision into one place and makes it total: a Decision is produced
// for a (Principal, Permission, Resource) triple or the request does not
// proceed.
//
// Two gates are independent and both must pass:
//
//	role gate    the principal's roles grant the action on the resource type
//	tenant gate  the resource belongs to the principal's tenant
//
// Neither implies the other. An admin of tenant A holds every permission and
// still cannot read a Task of tenant B; a member of tenant B with the viewer
// role shares the tenant and still cannot approve a repair.
package authz

import "strings"

// Resource is the kind of thing a Permission acts on. It is deliberately
// coarser than the table list: authorization that needs a distinct verb per
// table becomes a matrix nobody can audit.
type Resource string

const (
	ResourceTask              Resource = "task"
	ResourceJob               Resource = "job"
	ResourceFinding           Resource = "finding"
	ResourceRule              Resource = "rule"
	ResourceRepair            Resource = "repair"
	ResourceProviderOperation Resource = "provider_operation"
	ResourceQueue             Resource = "queue"
	ResourceMembership        Resource = "membership"
	ResourceTenant            Resource = "tenant"
)

// Action is what is being attempted. Read and Write are the ordinary CRUD
// split. Operate, Approve and Administer are separated because they are the
// three that cause damage an audit log cannot undo: Operate moves other
// people's work, Approve authorises a mutation of production business data,
// Administer changes who can do the previous two.
type Action string

const (
	ActionRead       Action = "read"
	ActionWrite      Action = "write"
	ActionOperate    Action = "operate"
	ActionApprove    Action = "approve"
	ActionAdminister Action = "administer"
)

// Permission is one cell of the role matrix.
type Permission struct {
	Resource Resource
	Action   Action
}

func (p Permission) String() string { return string(p.Resource) + ":" + string(p.Action) }

func (p Permission) Valid() bool {
	return validResources[p.Resource] && validActions[p.Action]
}

// ParsePermission accepts the "resource:action" form used in configuration and
// audit records. It rejects unknown names rather than defaulting, because a
// typo that parses into a permission nobody holds is a silent lockout and a
// typo that parses into a permission everybody holds is a breach.
func ParsePermission(raw string) (Permission, bool) {
	resource, action, found := strings.Cut(strings.TrimSpace(raw), ":")
	if !found {
		return Permission{}, false
	}
	permission := Permission{
		Resource: Resource(strings.TrimSpace(resource)),
		Action:   Action(strings.TrimSpace(action)),
	}
	if !permission.Valid() {
		return Permission{}, false
	}
	return permission, true
}

var validResources = map[Resource]bool{
	ResourceTask: true, ResourceJob: true, ResourceFinding: true,
	ResourceRule: true, ResourceRepair: true, ResourceProviderOperation: true,
	ResourceQueue: true, ResourceMembership: true, ResourceTenant: true,
}

var validActions = map[Action]bool{
	ActionRead: true, ActionWrite: true, ActionOperate: true,
	ActionApprove: true, ActionAdminister: true,
}

// Resources returns every known resource in a stable order. Tests use it to
// assert the role matrix is total rather than accidentally sparse.
func Resources() []Resource {
	return []Resource{
		ResourceTask, ResourceJob, ResourceFinding, ResourceRule,
		ResourceRepair, ResourceProviderOperation, ResourceQueue,
		ResourceMembership, ResourceTenant,
	}
}

// Actions returns every known action in a stable order.
func Actions() []Action {
	return []Action{
		ActionRead, ActionWrite, ActionOperate, ActionApprove, ActionAdminister,
	}
}
