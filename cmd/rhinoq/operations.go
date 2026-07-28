package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"os"
	"strconv"
	"strings"
	"text/tabwriter"
	"time"

	"github.com/madebyduy/RhinoQ/internal/runtime/shutdown"
	"github.com/madebyduy/RhinoQ/pkg/rhinoq"
)

func openClient(
	ctx context.Context,
	getenv func(string) string,
) (*rhinoq.Client, io.Closer, error) {
	db, err := openDatabase(ctx, getenv)
	if err != nil {
		return nil, nil, err
	}
	client, err := rhinoq.NewPostgres(db)
	if err != nil {
		_ = db.Close()
		return nil, nil, err
	}
	return client, db, nil
}

func runJobs(args []string, getenv func(string) string, output io.Writer) int {
	if len(args) == 0 || args[0] != "list" {
		fmt.Fprintln(output, "Usage: rhinoq jobs list [--queue name] [--states pending,dead] [--limit 50] [--json]")
		return 2
	}
	flags := flag.NewFlagSet("jobs list", flag.ContinueOnError)
	flags.SetOutput(output)
	queue := flags.String("queue", "", "queue name")
	states := flags.String("states", "", "comma-separated job states")
	limit := flags.Int("limit", 50, "maximum rows")
	offset := flags.Int("offset", 0, "row offset")
	asJSON := flags.Bool("json", false, "print JSON")
	if err := flags.Parse(args[1:]); err != nil {
		return 2
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	client, closer, err := openClient(ctx, getenv)
	if err != nil {
		return printOperationError(output, err)
	}
	defer closer.Close()
	jobs, err := client.ListJobs(ctx, rhinoq.JobQuery{
		Queue: *queue, States: splitCSV(*states), Offset: *offset, Limit: *limit,
	})
	if err != nil {
		return printOperationError(output, err)
	}
	if *asJSON {
		return printJSON(output, map[string]any{"jobs": jobs})
	}
	table := tabwriter.NewWriter(output, 0, 4, 2, ' ', 0)
	fmt.Fprintln(table, "ID\tQUEUE\tSTATE\tATTEMPTS\tPRIORITY\tCORRELATION")
	for _, job := range jobs {
		fmt.Fprintf(table, "%s\t%s\t%s\t%d\t%d\t%s\n",
			job.ID, job.Name, job.State, job.Attempts, job.Priority,
			emptyDash(job.CorrelationID))
	}
	_ = table.Flush()
	fmt.Fprintf(output, "\n%d job(s)\n", len(jobs))
	return 0
}

func runAttention(args []string, getenv func(string) string, output io.Writer) int {
	flags := flag.NewFlagSet("attention", flag.ContinueOnError)
	flags.SetOutput(output)
	queue := flags.String("queue", "", "optional queue filter")
	limit := flags.Int("limit", 50, "maximum rows")
	offset := flags.Int("offset", 0, "row offset")
	asJSON := flags.Bool("json", false, "print JSON")
	if err := flags.Parse(args); err != nil {
		return 2
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	client, closer, err := openClient(ctx, getenv)
	if err != nil {
		return printOperationError(output, err)
	}
	defer closer.Close()
	items, err := client.ListAttention(ctx, *queue, *offset, *limit)
	if err != nil {
		return printOperationError(output, err)
	}
	if *asJSON {
		return printJSON(output, map[string]any{"items": items})
	}
	table := tabwriter.NewWriter(output, 0, 4, 2, ' ', 0)
	fmt.Fprintln(table, "KIND\tQUEUE\tJOB / REFERENCE\tREASON\tOBSERVED")
	for _, item := range items {
		reference := item.JobID
		if reference == "" {
			reference = item.ReferenceID
		}
		fmt.Fprintf(table, "%s\t%s\t%s\t%s\t%s\n",
			item.Kind, emptyDash(item.Queue), emptyDash(reference),
			item.Reason, item.ObservedAt.UTC().Format(time.RFC3339))
	}
	_ = table.Flush()
	fmt.Fprintf(output, "\n%d item(s) need attention\n", len(items))
	return 0
}

func runQueue(args []string, getenv func(string) string, output io.Writer) int {
	if len(args) < 2 {
		fmt.Fprintln(output, "Usage: rhinoq queue <counts|pause|resume> <name>")
		return 2
	}
	action, name := args[0], strings.TrimSpace(args[1])
	if name == "" || (action != "counts" && action != "pause" && action != "resume") {
		fmt.Fprintln(output, "Usage: rhinoq queue <counts|pause|resume> <name>")
		return 2
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	client, closer, err := openClient(ctx, getenv)
	if err != nil {
		return printOperationError(output, err)
	}
	defer closer.Close()
	switch action {
	case "counts":
		counts, err := client.JobCounts(ctx, name)
		if err != nil {
			return printOperationError(output, err)
		}
		table := tabwriter.NewWriter(output, 0, 4, 2, ' ', 0)
		fmt.Fprintln(table, "STATE\tCOUNT")
		for _, state := range []string{
			"pending", "leased", "retry_wait", "blocked",
			"dead", "succeeded", "cancelled",
		} {
			fmt.Fprintf(table, "%s\t%d\n", state, counts[state])
		}
		_ = table.Flush()
	case "pause":
		if err := client.Pause(ctx, name); err != nil {
			return printOperationError(output, err)
		}
		fmt.Fprintf(output, "PASS queue %q is paused; running jobs were not interrupted\n", name)
	case "resume":
		if err := client.Resume(ctx, name); err != nil {
			return printOperationError(output, err)
		}
		fmt.Fprintf(output, "PASS queue %q is accepting claims again\n", name)
	}
	return 0
}

func runFindings(args []string, getenv func(string) string, output io.Writer) int {
	action := "list"
	if len(args) > 0 {
		action = args[0]
		args = args[1:]
	}
	if action == "list" {
		return runFindingList(args, getenv, output)
	}
	statuses := map[string]string{
		"acknowledge":    rhinoq.FindingAcknowledged,
		"resolve":        rhinoq.FindingResolved,
		"ignore":         rhinoq.FindingIgnored,
		"false-positive": rhinoq.FindingFalsePositive,
	}
	status, found := statuses[action]
	if !found {
		fmt.Fprintln(output, "Usage: rhinoq findings [list|acknowledge|resolve|ignore|false-positive]")
		return 2
	}
	return runFindingTransition(action, status, args, getenv, output)
}

func runRules(args []string, getenv func(string) string, output io.Writer) int {
	if len(args) == 0 {
		fmt.Fprintln(output, "Usage: rhinoq rules <list|enable|disable|run>")
		return 2
	}
	action := args[0]
	switch action {
	case "list":
		flags := flag.NewFlagSet("rules list", flag.ContinueOnError)
		flags.SetOutput(output)
		scope := flags.String("scope", "", "job or table")
		statuses := flags.String("statuses", "", "comma-separated statuses")
		limit := flags.Int("limit", 100, "maximum rows")
		offset := flags.Int("offset", 0, "row offset")
		asJSON := flags.Bool("json", false, "print JSON")
		if err := flags.Parse(args[1:]); err != nil {
			return 2
		}
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		client, closer, err := openClient(ctx, getenv)
		if err != nil {
			return printOperationError(output, err)
		}
		defer closer.Close()
		records, err := client.ListRules(ctx, rhinoq.RuleQuery{
			Scope: *scope, Statuses: splitCSV(*statuses),
			Offset: *offset, Limit: *limit,
		})
		if err != nil {
			return printOperationError(output, err)
		}
		if *asJSON {
			return printJSON(output, map[string]any{"rules": records})
		}
		table := tabwriter.NewWriter(output, 0, 4, 2, ' ', 0)
		fmt.Fprintln(table, "ID\tVERSION\tSCOPE\tSTATUS\tEVERY\tSUBJECT")
		for _, record := range records {
			fmt.Fprintf(table, "%s\t%d\t%s\t%s\t%s\t%s\n",
				record.ID, record.Version, record.Scope, record.Status,
				emptyDuration(record.Every), record.SubjectType)
		}
		_ = table.Flush()
		fmt.Fprintf(output, "\n%d Rule(s)\n", len(records))
		return 0
	case "enable", "disable":
		if len(args) != 2 || strings.TrimSpace(args[1]) == "" {
			fmt.Fprintf(output, "Usage: rhinoq rules %s <rule-id>\n", action)
			return 2
		}
		ctx, cancel := context.WithTimeout(context.Background(), 35*time.Second)
		defer cancel()
		client, closer, err := openClient(ctx, getenv)
		if err != nil {
			return printOperationError(output, err)
		}
		defer closer.Close()
		if action == "enable" {
			record, explanation, err := client.EnableRule(ctx, args[1])
			if err != nil {
				fmt.Fprintf(output, "FAIL Rule was not enabled: %v\n", err)
				for _, reason := range explanation.Reasons {
					fmt.Fprintf(output, "  - %s\n", reason)
				}
				return 1
			}
			fmt.Fprintf(output, "PASS Rule %s@v%d enabled · plan cost %.2f\n",
				record.ID, record.Version, explanation.PlanCost)
			return 0
		}
		record, err := client.DisableRule(ctx, args[1])
		if err != nil {
			return printOperationError(output, err)
		}
		fmt.Fprintf(output, "PASS Rule %s@v%d disabled\n", record.ID, record.Version)
		return 0
	case "run":
		return runRuleScheduler(args[1:], getenv, output)
	default:
		fmt.Fprintln(output, "Usage: rhinoq rules <list|enable|disable|run>")
		return 2
	}
}

func runRuleScheduler(
	args []string,
	getenv func(string) string,
	output io.Writer,
) int {
	flags := flag.NewFlagSet("rules run", flag.ContinueOnError)
	flags.SetOutput(output)
	owner := flags.String("owner", defaultProcessName("rules"), "unique scheduler identity")
	poll := flags.Duration("poll", time.Second, "idle polling interval")
	lease := flags.Duration("lease", time.Minute, "page lease duration")
	backoff := flags.Duration("error-backoff", 30*time.Second, "retry delay after an evaluation error")
	batch := flags.Int("batch", 4, "maximum Rules claimed per cycle")
	if err := flags.Parse(args); err != nil {
		return 2
	}
	ctx, stop := shutdown.Context(context.Background())
	defer stop()
	client, closer, err := openClient(ctx, getenv)
	if err != nil {
		return printOperationError(output, err)
	}
	defer closer.Close()
	fmt.Fprintf(output, "RhinoQ Rule scheduler started · owner=%s · Ctrl+C to stop\n", *owner)
	err = client.RunRuleScheduler(ctx, rhinoq.RuleSchedulerConfig{
		Owner: *owner, PollInterval: *poll, Lease: *lease,
		ErrorBackoff: *backoff, ClaimBatch: *batch,
		OnError: func(err error) {
			fmt.Fprintf(output, "WARN Rule evaluation: %v\n", err)
		},
	})
	if err != nil {
		return printOperationError(output, err)
	}
	fmt.Fprintln(output, "RhinoQ Rule scheduler stopped cleanly")
	return 0
}

func runFindingList(
	args []string,
	getenv func(string) string,
	output io.Writer,
) int {
	flags := flag.NewFlagSet("findings list", flag.ContinueOnError)
	flags.SetOutput(output)
	ruleID := flags.String("rule", "", "Rule ID")
	subjectType := flags.String("subject-type", "", "business subject type")
	subjectID := flags.String("subject", "", "business subject ID")
	statuses := flags.String("statuses", "open,regressed,acknowledged", "comma-separated statuses")
	includeSuppressed := flags.Bool("include-suppressed", false, "include active suppressions")
	limit := flags.Int("limit", 50, "maximum rows")
	offset := flags.Int("offset", 0, "row offset")
	asJSON := flags.Bool("json", false, "print JSON")
	if err := flags.Parse(args); err != nil {
		return 2
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	client, closer, err := openClient(ctx, getenv)
	if err != nil {
		return printOperationError(output, err)
	}
	defer closer.Close()
	records, err := client.ListFindings(ctx, rhinoq.FindingQuery{
		RuleID: *ruleID, SubjectType: *subjectType, SubjectID: *subjectID,
		Statuses: splitCSV(*statuses), IncludeSuppressed: *includeSuppressed,
		Offset: *offset, Limit: *limit,
	})
	if err != nil {
		return printOperationError(output, err)
	}
	if *asJSON {
		return printJSON(output, map[string]any{"findings": records})
	}
	table := tabwriter.NewWriter(output, 0, 4, 2, ' ', 0)
	fmt.Fprintln(table, "RULE\tSUBJECT\tSTATUS\tSEEN\tLAST OBSERVED\tOWNER")
	for _, record := range records {
		subject := record.SubjectType + "/" + record.SubjectID +
			"@v" + strconv.Itoa(record.InvariantVersion)
		fmt.Fprintf(table, "%s\t%s\t%s\t%d\t%s\t%s\n",
			record.RuleID, subject, record.Status, record.OccurrenceCount,
			record.LastSeen.UTC().Format(time.RFC3339), emptyDash(record.Actor))
	}
	_ = table.Flush()
	fmt.Fprintf(output, "\n%d finding(s)\n", len(records))
	return 0
}

func runFindingTransition(
	action, status string,
	args []string,
	getenv func(string) string,
	output io.Writer,
) int {
	flags := flag.NewFlagSet("findings "+action, flag.ContinueOnError)
	flags.SetOutput(output)
	ruleID := flags.String("rule", "", "Rule ID")
	subjectType := flags.String("subject-type", "", "business subject type")
	subjectID := flags.String("subject", "", "business subject ID")
	version := flags.Int("version", -1, "Rule invariant version")
	actor := flags.String("actor", "", "operator identity")
	reason := flags.String("reason", "", "decision reason")
	until := flags.String("until", "", "suppression duration, for example 24h")
	if err := flags.Parse(args); err != nil {
		return 2
	}
	if *ruleID == "" || *subjectType == "" || *subjectID == "" ||
		*version < 0 || *actor == "" {
		fmt.Fprintln(output, "FAIL --rule, --subject-type, --subject, --version and --actor are required")
		return 2
	}
	var untilAt time.Time
	if status == rhinoq.FindingIgnored || status == rhinoq.FindingFalsePositive {
		duration, err := time.ParseDuration(*until)
		if err != nil || duration <= 0 {
			fmt.Fprintln(output, "FAIL suppression requires a positive --until duration, for example 24h")
			return 2
		}
		untilAt = time.Now().UTC().Add(duration)
		if strings.TrimSpace(*reason) == "" {
			fmt.Fprintln(output, "FAIL suppression requires --reason")
			return 2
		}
	}
	if status == rhinoq.FindingResolved && strings.TrimSpace(*reason) == "" {
		fmt.Fprintln(output, "FAIL resolve requires --reason")
		return 2
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	client, closer, err := openClient(ctx, getenv)
	if err != nil {
		return printOperationError(output, err)
	}
	defer closer.Close()
	record, err := client.TransitionFinding(ctx, rhinoq.FindingKey{
		RuleID: *ruleID, SubjectType: *subjectType,
		SubjectID: *subjectID, InvariantVersion: *version,
	}, rhinoq.FindingTransition{
		Status: status, Actor: *actor, Reason: *reason, Until: untilAt,
	})
	if err != nil {
		return printOperationError(output, err)
	}
	fmt.Fprintf(output, "PASS %s/%s/%s@v%d -> %s\n",
		record.RuleID, record.SubjectType, record.SubjectID,
		record.InvariantVersion, record.Status)
	return 0
}

func splitCSV(raw string) []string {
	if strings.TrimSpace(raw) == "" {
		return nil
	}
	parts := strings.Split(raw, ",")
	result := make([]string, 0, len(parts))
	for _, part := range parts {
		if value := strings.TrimSpace(part); value != "" {
			result = append(result, value)
		}
	}
	return result
}

func printJSON(output io.Writer, value any) int {
	encoder := json.NewEncoder(output)
	encoder.SetIndent("", "  ")
	if err := encoder.Encode(value); err != nil {
		return printOperationError(output, err)
	}
	return 0
}

func printOperationError(output io.Writer, err error) int {
	fmt.Fprintf(output, "FAIL %v\n", err)
	return 1
}

func emptyDash(value string) string {
	if value == "" {
		return "—"
	}
	return value
}

func emptyDuration(value time.Duration) string {
	if value <= 0 {
		return "—"
	}
	return value.String()
}

func defaultProcessName(component string) string {
	host, err := os.Hostname()
	if err != nil || host == "" {
		host = "localhost"
	}
	return fmt.Sprintf("%s-%s-%d", host, component, os.Getpid())
}
