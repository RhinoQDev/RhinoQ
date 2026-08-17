package database

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strconv"
)

// CapacityReport compares what this process is allowed to open against what the
// server can actually give out.
//
// The failure it exists to catch is not gradual. PostgreSQL does not slow down
// as it approaches `max_connections`; it refuses the next connection outright,
// and it refuses it to every client, including the ones that were already
// healthy and including processes that have nothing to do with RhinoQ. An
// operator who can see the number beforehand never has that outage.
type CapacityReport struct {
	// MaxConnections is the server-wide ceiling.
	MaxConnections int
	// SuperuserReserved is held back from ordinary roles, so it is not headroom.
	SuperuserReserved int
	// InUse counts backends currently connected, this process included.
	InUse int
	// PoolMaxOpen is what one replica of this process may open.
	PoolMaxOpen int
	// Replicas is how many replicas the operator says will run this pool.
	Replicas int
}

// Available is what ordinary roles may hold in total.
func (r CapacityReport) Available() int {
	available := r.MaxConnections - r.SuperuserReserved
	if available < 0 {
		return 0
	}
	return available
}

// Demand is the worst case this deployment can ask for.
func (r CapacityReport) Demand() int {
	replicas := r.Replicas
	if replicas < 1 {
		replicas = 1
	}
	return r.PoolMaxOpen * replicas
}

// Crowded reports whether the deployment can exhaust the server. The threshold
// is deliberately below 100%: the margin is what a rolling restart needs, since
// old and new replicas hold connections at the same time.
func (r CapacityReport) Crowded() bool {
	available := r.Available()
	return available > 0 && float64(r.Demand()) > 0.8*float64(available)
}

// Explain states the finding and the specific number to change.
func (r CapacityReport) Explain() string {
	if !r.Crowded() {
		return fmt.Sprintf(
			"%d of %d connections available to this role; %d replica(s) × max_open=%d may hold %d",
			r.Available()-r.InUse, r.Available(), max(r.Replicas, 1), r.PoolMaxOpen, r.Demand())
	}
	return fmt.Sprintf(
		"%d replica(s) × max_open=%d may hold %d connections, over 80%% of the %d available; "+
			"lower RHINOQ_DB_MAX_OPEN_CONNS or raise the server's max_connections",
		max(r.Replicas, 1), r.PoolMaxOpen, r.Demand(), r.Available())
}

// InspectCapacity asks the server for its limits rather than assuming them.
func InspectCapacity(
	ctx context.Context,
	db *sql.DB,
	settings Settings,
	replicas int,
) (CapacityReport, error) {
	if db == nil {
		return CapacityReport{}, errors.New("postgres database is required")
	}
	report := CapacityReport{PoolMaxOpen: settings.MaxOpenConns, Replicas: replicas}

	var err error
	if report.MaxConnections, err = showInt(ctx, db, "max_connections"); err != nil {
		return CapacityReport{}, err
	}
	// Absent on some managed providers; zero reserved is the safe reading.
	report.SuperuserReserved, _ = showInt(ctx, db, "superuser_reserved_connections")

	if err := db.QueryRowContext(ctx,
		`SELECT count(*) FROM pg_stat_activity WHERE backend_type = 'client backend'`,
	).Scan(&report.InUse); err != nil {
		return CapacityReport{}, fmt.Errorf("count active backends: %w", err)
	}
	return report, nil
}

func showInt(ctx context.Context, db *sql.DB, setting string) (int, error) {
	var raw string
	if err := db.QueryRowContext(ctx,
		`SELECT current_setting($1, true)`, setting,
	).Scan(&raw); err != nil {
		return 0, fmt.Errorf("read %s: %w", setting, err)
	}
	value, err := strconv.Atoi(raw)
	if err != nil {
		return 0, fmt.Errorf("read %s: %q is not a number", setting, raw)
	}
	return value, nil
}
