// Package migrations embeds and applies RhinoQ's ordered PostgreSQL schema
// migrations. Applying is explicit; status and plan operations never mutate.
package migrations

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"embed"
	"encoding/hex"
	"errors"
	"fmt"
	"io/fs"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
)

//go:embed *.sql
var migrationFiles embed.FS

const (
	migrationTable  = "public.rhinoq_schema_migrations"
	advisoryLockKey = int64(7_246_466_111)
)

var (
	filePattern         = regexp.MustCompile(`^([0-9]{3})_[a-z0-9_]+\.sql$`)
	ErrUntrackedSchema  = errors.New("RhinoQ tables exist without migration history")
	ErrChecksumDrift    = errors.New("an applied RhinoQ migration no longer matches the embedded SQL")
	ErrSchemaAhead      = errors.New("the database schema is newer than this RhinoQ binary")
	ErrMigrationHistory = errors.New(
		"RhinoQ migration history is not a contiguous applied prefix",
	)
)

type Definition struct {
	Version  int
	Name     string
	Checksum string
	SQL      string
}

type State string

const (
	Pending State = "pending"
	Applied State = "applied"
)

type Status struct {
	Definition
	State     State
	AppliedAt time.Time
}

type Runner struct {
	db      *sql.DB
	catalog []Definition
}

func NewRunner(db *sql.DB) (*Runner, error) {
	if db == nil {
		return nil, errors.New("PostgreSQL database is required")
	}
	catalog, err := Catalog()
	if err != nil {
		return nil, err
	}
	return &Runner{db: db, catalog: catalog}, nil
}

func Catalog() ([]Definition, error) {
	names, err := fs.Glob(migrationFiles, "*.sql")
	if err != nil {
		return nil, err
	}
	sort.Strings(names)
	result := make([]Definition, 0, len(names))
	lastVersion := 0
	for _, name := range names {
		match := filePattern.FindStringSubmatch(name)
		if match == nil {
			return nil, fmt.Errorf("invalid migration filename %q", name)
		}
		version, err := strconv.Atoi(match[1])
		if err != nil || version != lastVersion+1 {
			return nil, fmt.Errorf(
				"migration versions must be contiguous: got %q after %03d",
				name, lastVersion,
			)
		}
		body, err := migrationFiles.ReadFile(name)
		if err != nil {
			return nil, err
		}
		sum := sha256.Sum256(body)
		result = append(result, Definition{
			Version: version, Name: name,
			Checksum: hex.EncodeToString(sum[:]), SQL: string(body),
		})
		lastVersion = version
	}
	if len(result) == 0 {
		return nil, errors.New("no embedded RhinoQ migrations")
	}
	return result, nil
}

// Status reports schema state without creating tables or changing data.
func (r *Runner) Status(ctx context.Context) ([]Status, error) {
	tracked, hasObjects, err := inspectSchema(ctx, r.db)
	if err != nil {
		return nil, err
	}
	if !tracked {
		if hasObjects {
			return nil, ErrUntrackedSchema
		}
		return pendingCatalog(r.catalog), nil
	}
	applied, err := loadApplied(ctx, r.db)
	if err != nil {
		return nil, err
	}
	if err := validateApplied(r.catalog, applied); err != nil {
		return nil, err
	}
	return statusesFromApplied(r.catalog, applied), nil
}

// Apply serializes migration writers with a PostgreSQL advisory lock and
// applies each file in its own transaction. Already-applied checksums must
// match exactly.
func (r *Runner) Apply(ctx context.Context) ([]Status, error) {
	conn, err := r.db.Conn(ctx)
	if err != nil {
		return nil, err
	}
	defer conn.Close()
	if _, err := conn.ExecContext(
		ctx, `SELECT pg_advisory_lock($1)`, advisoryLockKey,
	); err != nil {
		return nil, err
	}
	defer func() {
		unlockCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_, _ = conn.ExecContext(
			unlockCtx, `SELECT pg_advisory_unlock($1)`, advisoryLockKey,
		)
	}()

	tracked, hasObjects, err := inspectSchema(ctx, conn)
	if err != nil {
		return nil, err
	}
	if !tracked && hasObjects {
		return nil, ErrUntrackedSchema
	}
	if _, err := conn.ExecContext(ctx, `
		CREATE TABLE IF NOT EXISTS public.rhinoq_schema_migrations (
			version     integer PRIMARY KEY CHECK (version > 0),
			name        text NOT NULL UNIQUE,
			checksum    text NOT NULL CHECK (length(checksum) = 64),
			applied_at  timestamptz NOT NULL DEFAULT clock_timestamp()
		)`); err != nil {
		return nil, err
	}
	applied, err := loadApplied(ctx, conn)
	if err != nil {
		return nil, err
	}
	if err := validateApplied(r.catalog, applied); err != nil {
		return nil, err
	}
	for _, definition := range r.catalog {
		if existing, found := applied[definition.Version]; found {
			if existing.name != definition.Name ||
				existing.checksum != definition.Checksum {
				return nil, fmt.Errorf(
					"%w: version %03d", ErrChecksumDrift, definition.Version,
				)
			}
			continue
		}
		tx, err := conn.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelSerializable})
		if err != nil {
			return nil, err
		}
		if _, err := tx.ExecContext(ctx, definition.SQL); err != nil {
			_ = tx.Rollback()
			return nil, fmt.Errorf("apply %s: %w", definition.Name, err)
		}
		if _, err := tx.ExecContext(ctx, `
			INSERT INTO public.rhinoq_schema_migrations (
				version, name, checksum
			) VALUES ($1, $2, $3)`,
			definition.Version, definition.Name, definition.Checksum,
		); err != nil {
			_ = tx.Rollback()
			return nil, fmt.Errorf("record %s: %w", definition.Name, err)
		}
		if err := tx.Commit(); err != nil {
			return nil, fmt.Errorf("commit %s: %w", definition.Name, err)
		}
	}
	return statusOnConn(ctx, conn, r.catalog)
}

func pendingCatalog(catalog []Definition) []Status {
	statuses := make([]Status, 0, len(catalog))
	for _, definition := range catalog {
		statuses = append(statuses, Status{
			Definition: definition, State: Pending,
		})
	}
	return statuses
}

type appliedMigration struct {
	name, checksum string
	at             time.Time
}

type rowQuerier interface {
	QueryRowContext(context.Context, string, ...any) *sql.Row
}

func inspectSchema(
	ctx context.Context,
	query rowQuerier,
) (tracked, hasObjects bool, err error) {
	err = query.QueryRowContext(ctx, `
		SELECT to_regclass($1) IS NOT NULL,
		       EXISTS (
			       SELECT 1
			       FROM pg_class AS object
			       JOIN pg_namespace AS namespace
			         ON namespace.oid = object.relnamespace
			       WHERE namespace.nspname = 'public'
			         AND left(object.relname, length('rhinoq_')) = 'rhinoq_'
			         AND object.relname <> 'rhinoq_schema_migrations'
		       )
		       OR EXISTS (
			       SELECT 1
			       FROM pg_namespace
			       WHERE nspname = 'rhinoq'
		       )`,
		migrationTable,
	).Scan(&tracked, &hasObjects)
	return tracked, hasObjects, err
}

func loadApplied(
	ctx context.Context,
	query interface {
		QueryContext(context.Context, string, ...any) (*sql.Rows, error)
	},
) (map[int]appliedMigration, error) {
	rows, err := query.QueryContext(ctx, `
		SELECT version, name, checksum, applied_at
		FROM public.rhinoq_schema_migrations
		ORDER BY version`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := make(map[int]appliedMigration)
	for rows.Next() {
		var version int
		var record appliedMigration
		if err := rows.Scan(
			&version, &record.name, &record.checksum, &record.at,
		); err != nil {
			return nil, err
		}
		result[version] = record
	}
	return result, rows.Err()
}

func statusOnConn(
	ctx context.Context,
	conn *sql.Conn,
	catalog []Definition,
) ([]Status, error) {
	applied, err := loadApplied(ctx, conn)
	if err != nil {
		return nil, err
	}
	if err := validateApplied(catalog, applied); err != nil {
		return nil, err
	}
	return statusesFromApplied(catalog, applied), nil
}

func validateApplied(
	catalog []Definition,
	applied map[int]appliedMigration,
) error {
	definitions := make(map[int]Definition, len(catalog))
	for _, definition := range catalog {
		definitions[definition.Version] = definition
	}
	for version, record := range applied {
		definition, found := definitions[version]
		if !found {
			return fmt.Errorf(
				"%w: database contains unknown version %03d",
				ErrSchemaAhead, version,
			)
		}
		if record.name != definition.Name ||
			record.checksum != definition.Checksum {
			return fmt.Errorf(
				"%w: version %03d expected %s (%s), database has %s (%s)",
				ErrChecksumDrift, version, definition.Name,
				definition.Checksum, record.name, record.checksum,
			)
		}
	}
	foundPending := false
	for _, definition := range catalog {
		_, found := applied[definition.Version]
		if !found {
			foundPending = true
			continue
		}
		if foundPending {
			return fmt.Errorf(
				"%w: version %03d is applied after an earlier missing version",
				ErrMigrationHistory, definition.Version,
			)
		}
	}
	return nil
}

func statusesFromApplied(
	catalog []Definition,
	applied map[int]appliedMigration,
) []Status {
	statuses := make([]Status, 0, len(catalog))
	for _, definition := range catalog {
		record, found := applied[definition.Version]
		state := Pending
		if found {
			state = Applied
		}
		statuses = append(statuses, Status{
			Definition: definition, State: state, AppliedAt: record.at,
		})
	}
	return statuses
}

func PendingCount(statuses []Status) int {
	count := 0
	for _, status := range statuses {
		if status.State == Pending {
			count++
		}
	}
	return count
}

func Summary(statuses []Status) string {
	if len(statuses) == 0 {
		return "no migrations"
	}
	pending := PendingCount(statuses)
	return fmt.Sprintf(
		"schema %03d/%03d · %d pending",
		len(statuses)-pending, len(statuses), pending,
	)
}

func SQLPlan(statuses []Status) string {
	var builder strings.Builder
	for _, status := range statuses {
		if status.State != Pending {
			continue
		}
		fmt.Fprintf(&builder, "-- %s · sha256:%s\n", status.Name, status.Checksum)
		builder.WriteString(status.SQL)
		if !strings.HasSuffix(status.SQL, "\n") {
			builder.WriteByte('\n')
		}
		builder.WriteByte('\n')
	}
	return builder.String()
}
