package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"strings"
	"time"

	"github.com/rhinoq/rhinoq/internal/infrastructure/migrations"
)

func runMigrate(
	args []string,
	getenv func(string) string,
	output io.Writer,
) int {
	action := "plan"
	if len(args) > 0 {
		action = args[0]
	}
	if action != "plan" && action != "status" &&
		action != "apply" && action != "sql" {
		fmt.Fprintf(output, "FAIL unknown migrate action %q\n", action)
		fmt.Fprintln(output, "Usage: rhinoq migrate [plan|status|apply|sql]")
		return 2
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	db, err := openDatabase(ctx, getenv)
	if err != nil {
		fmt.Fprintf(output, "FAIL database\n  %v\n", err)
		return 1
	}
	defer db.Close()
	runner, err := migrations.NewRunner(db)
	if err != nil {
		fmt.Fprintf(output, "FAIL migration catalog\n  %v\n", err)
		return 1
	}
	statuses, err := runner.Status(ctx)
	if err != nil {
		printMigrationError(output, err)
		return 1
	}
	if action == "apply" {
		statuses, err = runner.Apply(ctx)
		if err != nil {
			printMigrationError(output, err)
			return 1
		}
		fmt.Fprintf(output, "PASS %s\n", migrations.Summary(statuses))
		fmt.Fprintln(output, "All RhinoQ migrations are applied.")
		return 0
	}
	if action == "sql" {
		plan := migrations.SQLPlan(statuses)
		if plan == "" {
			fmt.Fprintln(output, "-- schema is up to date")
			return 0
		}
		_, _ = io.WriteString(output, plan)
		return 0
	}
	fmt.Fprintf(output, "RhinoQ migration %s\n", action)
	for _, status := range statuses {
		marker := "○"
		if status.State == migrations.Applied {
			marker = "✓"
		}
		fmt.Fprintf(output, "  %s %03d  %-8s  %s\n",
			marker, status.Version, status.State, status.Name)
	}
	fmt.Fprintf(output, "\n%s\n", migrations.Summary(statuses))
	if action == "plan" && migrations.PendingCount(statuses) > 0 {
		fmt.Fprintln(output, "No changes made. Run `rhinoq migrate apply` to apply this plan.")
	}
	return 0
}

func printMigrationError(output io.Writer, err error) {
	fmt.Fprintln(output, "FAIL migration state")
	fmt.Fprintf(output, "  %v\n", err)
	if errors.Is(err, migrations.ErrUntrackedSchema) {
		fmt.Fprintln(output, "  Existing RhinoQ tables were created before migration tracking.")
		fmt.Fprintln(output, "  Do not apply automatically; review and baseline this database manually.")
	}
	if errors.Is(err, migrations.ErrChecksumDrift) {
		fmt.Fprintln(output, "  An applied migration changed after deployment. Restore the original SQL; never edit migration history.")
	}
	if errors.Is(err, migrations.ErrSchemaAhead) {
		fmt.Fprintln(output, "  Upgrade the RhinoQ CLI/application before operating on this database.")
	}
	if errors.Is(err, migrations.ErrMigrationHistory) {
		fmt.Fprintln(output, "  Do not auto-repair migration rows; restore the authoritative history from backup or deployment records.")
	}
}

func migrateUsage() string {
	return strings.TrimSpace(`
rhinoq migrate plan     show pending migrations; never writes
rhinoq migrate status   show installed and pending versions
rhinoq migrate sql      print pending SQL for DBA review
rhinoq migrate apply    apply pending migrations under an advisory lock
`)
}
