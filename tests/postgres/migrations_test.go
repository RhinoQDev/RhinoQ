package postgres_test

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/rhinoq/rhinoq/internal/infrastructure/migrations"
)

func TestEmbeddedMigrationRunnerIsCurrentAndIdempotent(t *testing.T) {
	if testDB == nil {
		t.Skip("set RHINOQ_TEST_DATABASE_URL to run the PostgreSQL harness")
	}
	runner, err := migrations.NewRunner(testDB)
	if err != nil {
		t.Fatal(err)
	}
	statuses, err := runner.Status(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if pending := migrations.PendingCount(statuses); pending != 0 {
		t.Fatalf("test schema must be current, pending=%d", pending)
	}
	statuses, err = runner.Apply(context.Background())
	if err != nil {
		t.Fatalf("reapplying a current catalog must be a no-op: %v", err)
	}
	if pending := migrations.PendingCount(statuses); pending != 0 {
		t.Fatalf("idempotent apply must stay current, pending=%d", pending)
	}
}

func TestEmbeddedMigrationRunnerRefusesANewerDatabase(t *testing.T) {
	if testDB == nil {
		t.Skip("set RHINOQ_TEST_DATABASE_URL to run the PostgreSQL harness")
	}
	_, err := testDB.Exec(`
		INSERT INTO public.rhinoq_schema_migrations (
			version, name, checksum
		) VALUES (999, '999_future.sql', $1)`,
		strings.Repeat("f", 64),
	)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if _, err := testDB.Exec(`
			DELETE FROM public.rhinoq_schema_migrations WHERE version = 999`,
		); err != nil {
			t.Errorf("clean future migration: %v", err)
		}
	})

	runner, err := migrations.NewRunner(testDB)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := runner.Status(context.Background()); !errors.Is(
		err, migrations.ErrSchemaAhead,
	) {
		t.Fatalf("older binary must refuse a newer database, got %v", err)
	}
}
