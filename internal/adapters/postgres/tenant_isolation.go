package postgres

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
)

// IsolationReport is what RhinoQ can prove about the tenant boundary on the
// connection it was actually given, as opposed to what the migrations asked
// for. The two differ more often than they should: PostgreSQL exempts
// superusers and BYPASSRLS roles from row-level security, FORCE included, and
// the official postgres image makes POSTGRES_USER a superuser. A deployment
// that connects with that role gets no isolation and no error, and every test
// it runs still passes.
//
// That silence is the reason this type exists. Isolation that cannot be
// observed at runtime is a claim, not a control.
type IsolationReport struct {
	Role string
	// Exempt is the finding that matters: this role bypasses every policy.
	Exempt        bool
	Superuser     bool
	BypassRLS     bool
	TenantSession string
	// Unprotected lists tenant-owned tables that are missing a forced policy,
	// which is what a partially applied or manually edited schema looks like.
	Unprotected []string
}

// Holds reports whether the boundary is actually in force on this connection.
func (r IsolationReport) Holds() bool {
	return !r.Exempt && len(r.Unprotected) == 0
}

// Explain renders the report the way an operator needs to read it: what is
// wrong, and the specific thing to do about it.
func (r IsolationReport) Explain() string {
	if r.Holds() {
		if r.TenantSession == "" {
			return fmt.Sprintf(
				"row-level security is in force for %q, but this session announced no tenant, so it reads nothing",
				r.Role)
		}
		return fmt.Sprintf("row-level security is in force for %q in tenant %s",
			r.Role, r.TenantSession)
	}
	var problems []string
	if r.Exempt {
		attribute := "BYPASSRLS"
		if r.Superuser {
			attribute = "SUPERUSER"
		}
		problems = append(problems, fmt.Sprintf(
			"the role %q holds %s, so PostgreSQL ignores every tenant policy and "+
				"all tenants share one dataset; connect as a role created with "+
				"NOSUPERUSER NOBYPASSRLS",
			r.Role, attribute))
	}
	if len(r.Unprotected) > 0 {
		problems = append(problems, fmt.Sprintf(
			"these tenant-owned tables have no forced row-level policy: %s; "+
				"re-run `rhinoq migrate` so migration 027 is applied",
			strings.Join(r.Unprotected, ", ")))
	}
	return strings.Join(problems, "; ")
}

// ErrTenantIsolationOff is returned by RequireTenantIsolation. It is a distinct
// error so a caller can choose to refuse to start rather than log and continue.
var ErrTenantIsolationOff = errors.New("tenant isolation is not in force")

// InspectTenantIsolation asks the database — not the migration files — whether
// the boundary is real on this connection.
func InspectTenantIsolation(ctx context.Context, db *sql.DB) (IsolationReport, error) {
	if db == nil {
		return IsolationReport{}, errors.New("postgres database is required")
	}
	report := IsolationReport{}
	err := db.QueryRowContext(ctx, `
		SELECT current_user,
		       rolsuper,
		       rolbypassrls,
		       coalesce(current_setting('rhinoq.tenant_id', true), '')
		FROM pg_roles WHERE rolname = current_user`).
		Scan(&report.Role, &report.Superuser, &report.BypassRLS, &report.TenantSession)
	if err != nil {
		return IsolationReport{}, fmt.Errorf("read the current role: %w", err)
	}
	report.Exempt = report.Superuser || report.BypassRLS

	// relforcerowsecurity rather than relrowsecurity: ENABLE alone still lets
	// the table owner through, and the owner is who a small deployment
	// connects as.
	rows, err := db.QueryContext(ctx, `
		SELECT c.relname
		FROM pg_class c
		JOIN pg_namespace n ON n.oid = c.relnamespace
		WHERE n.nspname = 'public'
		  AND c.relkind = 'r'
		  AND c.relname = ANY($1)
		  AND NOT c.relforcerowsecurity
		ORDER BY c.relname`, tenantOwnedTables())
	if err != nil {
		return IsolationReport{}, fmt.Errorf("read row-level security state: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			return IsolationReport{}, err
		}
		report.Unprotected = append(report.Unprotected, name)
	}
	return report, rows.Err()
}

// RequireTenantIsolation is the startup guard. A process that would serve more
// than one tenant from a connection with no boundary should not start: the
// damage from serving tenant A's data to tenant B is not recoverable by
// restarting with the right role afterwards.
func RequireTenantIsolation(ctx context.Context, db *sql.DB) error {
	report, err := InspectTenantIsolation(ctx, db)
	if err != nil {
		return err
	}
	if !report.Holds() {
		return fmt.Errorf("%w: %s", ErrTenantIsolationOff, report.Explain())
	}
	return nil
}

// tenantOwnedTables is the list migration 027 protects. It is duplicated here
// deliberately: if a later migration adds a tenant-owned table and forgets the
// policy, this check should notice, and it can only notice against an
// independent list.
func tenantOwnedTables() []string {
	return []string{
		"rhinoq_credentials",
		"rhinoq_findings",
		"rhinoq_jobs",
		"rhinoq_memberships",
		"rhinoq_provider_operation_evidence",
		"rhinoq_provider_operations",
		"rhinoq_queue_controls",
		"rhinoq_repairs",
		"rhinoq_rules",
		"rhinoq_task_executions",
		"rhinoq_tasks",
		"rhinoq_tenants",
	}
}
