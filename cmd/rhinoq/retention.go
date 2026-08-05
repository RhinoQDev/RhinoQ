package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"text/tabwriter"
	"time"

	"github.com/madebyduy/RhinoQ/internal/adapters/postgres"
	"github.com/madebyduy/RhinoQ/internal/application/retention"
)

// runRetention reclaims evidence that has outlived the operator's window.
//
// The largest table RhinoQ owns is rhinoq_subject_outcomes: one row per subject
// per Rule version, written by every scan. Before this command the only advice
// was a paragraph in docs/retention.md, and the table it was really about was
// not even named there.
func runRetention(args []string, getenv func(string) string, output io.Writer) int {
	if len(args) == 0 || args[0] != "prune" {
		fmt.Fprintln(output, "Usage: rhinoq retention prune [--older-than 90d] [--rule id] [--batch 5000] [--apply] [--json]")
		return 2
	}
	flags := flag.NewFlagSet("retention prune", flag.ContinueOnError)
	flags.SetOutput(output)
	olderThan := flags.String("older-than", "90d", "age at which evidence becomes prunable")
	ruleID := flags.String("rule", "", "narrow subject outcomes and finding history to one Rule")
	batch := flags.Int("batch", retention.DefaultBatch, "rows deleted per statement")
	apply := flags.Bool("apply", false, "perform the plan; without it nothing is deleted")
	asJSON := flags.Bool("json", false, "machine-readable output")
	if err := flags.Parse(args[1:]); err != nil {
		return 2
	}
	age, err := parseRetentionAge(*olderThan)
	if err != nil {
		fmt.Fprintf(output, "FAIL %v\n", err)
		return 2
	}

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Minute)
	defer cancel()
	db, err := openDatabase(ctx, getenv)
	if err != nil {
		fmt.Fprintf(output, "FAIL open database: %v\n", err)
		return 1
	}
	defer db.Close()
	store, err := postgres.NewRetentionStore(db)
	if err != nil {
		fmt.Fprintf(output, "FAIL build retention store: %v\n", err)
		return 1
	}
	service, err := retention.New(store, nil)
	if err != nil {
		fmt.Fprintf(output, "FAIL build retention service: %v\n", err)
		return 1
	}

	result, err := service.Prune(ctx, retention.Request{
		OlderThan: age, RuleID: *ruleID, Batch: *batch, Apply: *apply,
	})
	if err != nil {
		fmt.Fprintf(output, "FAIL %v\n", err)
		return 1
	}

	if *asJSON {
		payload := map[string]any{
			"cutoff":  result.Plan.Cutoff.UTC().Format(time.RFC3339),
			"applied": result.Applied,
			"total":   result.Plan.Total(),
			"targets": result.Plan.Targets,
		}
		encoder := json.NewEncoder(output)
		encoder.SetIndent("", "  ")
		if err := encoder.Encode(payload); err != nil {
			fmt.Fprintf(output, "FAIL encode: %v\n", err)
			return 1
		}
		return 0
	}

	verb := "would remove"
	if result.Applied {
		verb = "removed"
	}
	fmt.Fprintf(output, "Cutoff: %s (evidence older than %s)\n\n",
		result.Plan.Cutoff.UTC().Format(time.RFC3339), *olderThan)
	writer := tabwriter.NewWriter(output, 0, 0, 2, ' ', 0)
	fmt.Fprintln(writer, "TABLE\tROWS\tWHAT")
	for _, target := range result.Plan.Targets {
		fmt.Fprintf(writer, "%s\t%d\t%s\n", target.Table, target.Rows, target.What)
	}
	writer.Flush()
	fmt.Fprintf(output, "\n%s %d row(s) in total.\n", verb, result.Plan.Total())
	if !result.Applied {
		fmt.Fprintln(output, "No changes made. Add --apply to perform this plan.")
	} else {
		fmt.Fprintln(output, "PostgreSQL reuses this space for new rows. Run VACUUM (or")
		fmt.Fprintln(output, "VACUUM FULL during a maintenance window) to return it to the disk.")
	}
	return 0
}

// parseRetentionAge accepts Go durations plus a day suffix, because a retention
// window is stated in days and "2160h" is not a number anyone verifies.
func parseRetentionAge(value string) (time.Duration, error) {
	if len(value) > 1 && value[len(value)-1] == 'd' {
		days, err := time.ParseDuration(value[:len(value)-1] + "h")
		if err != nil {
			return 0, fmt.Errorf("--older-than %q is not a valid age", value)
		}
		return days * 24, nil
	}
	age, err := time.ParseDuration(value)
	if err != nil {
		return 0, fmt.Errorf("--older-than %q is not a valid age: use 90d, 720h or 30m", value)
	}
	return age, nil
}
