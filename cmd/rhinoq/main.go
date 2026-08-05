package main

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"

	"github.com/madebyduy/RhinoQ/internal/infrastructure/config"
	"github.com/madebyduy/RhinoQ/internal/infrastructure/migrations"
)

// version is stamped by the release build with
// -ldflags "-X main.version=<tag>". A build from source keeps the development
// value, so `rhinoq version` never claims to be a release it is not.
var version = "0.1.0-dev"

func main() {
	command := "help"
	if len(os.Args) > 1 {
		command = os.Args[1]
	}
	if command != "help" && len(os.Args) > 2 &&
		(os.Args[2] == "-h" || os.Args[2] == "--help") {
		if runHelp([]string{command}, os.Stdout) != 0 {
			os.Exit(2)
		}
		return
	}
	switch command {
	case "help", "-h", "--help":
		if runHelp(os.Args[2:], os.Stdout) != 0 {
			os.Exit(2)
		}
	case "doctor":
		reportOnly, deprecatedCI, invalid := doctorFlags(os.Args[2:])
		if invalid != "" {
			fmt.Fprintf(os.Stderr, "FAIL unknown doctor option %q\n", invalid)
			fmt.Fprintln(os.Stderr, "Usage: rhinoq doctor [--report]")
			os.Exit(2)
		}
		if deprecatedCI {
			fmt.Println("NOTE --ci is deprecated and does nothing: any FAIL already exits 1.")
			fmt.Println("     Drop the flag, or use --report to print the diagnosis and exit 0.")
			fmt.Println()
		}
		os.Exit(runDoctor(reportOnly))
	case "init":
		os.Exit(runInit(os.Args[2:], os.Stdout))
	case "migrate":
		os.Exit(runMigrate(os.Args[2:], os.Getenv, os.Stdout))
	case "jobs":
		os.Exit(runJobs(os.Args[2:], os.Getenv, os.Stdout))
	case "attention":
		os.Exit(runAttention(os.Args[2:], os.Getenv, os.Stdout))
	case "queue":
		os.Exit(runQueue(os.Args[2:], os.Getenv, os.Stdout))
	case "findings":
		os.Exit(runFindings(os.Args[2:], os.Getenv, os.Stdout))
	case "scan":
		os.Exit(runScan(os.Args[2:], os.Getenv, os.Stdout))
	case "rules":
		os.Exit(runRules(os.Args[2:], os.Getenv, os.Stdout))
	case "notify":
		os.Exit(runNotify(os.Args[2:], os.Getenv, os.Stdout))
	case "retention":
		os.Exit(runRetention(os.Args[2:], os.Getenv, os.Stdout))
	case "workbench", "ui":
		os.Exit(runWorkbench(os.Args[2:], os.Getenv, os.Stdout))
	case "explain":
		os.Exit(runExplain(os.Args[2:], os.Getenv, os.Stdout))
	case "version":
		fmt.Println("rhinoq " + version)
	default:
		fmt.Fprintf(os.Stderr, "FAIL unknown command %q\n\n", command)
		_ = runHelp(nil, os.Stderr)
		os.Exit(2)
	}
}

func runExplain(args []string, getenv func(string) string, output io.Writer) int {
	if len(args) != 1 || strings.TrimSpace(args[0]) == "" {
		fmt.Fprintln(output, "FAIL rule id is required")
		fmt.Fprintln(output, "Usage: rhinoq explain <rule-id>")
		return 2
	}
	agentURL := strings.TrimRight(getenv("RHINOQ_AGENT_URL"), "/")
	if agentURL == "" {
		ctx, cancel := context.WithTimeout(context.Background(), 35*time.Second)
		defer cancel()
		client, closer, err := openClient(ctx, getenv)
		if err != nil {
			fmt.Fprintf(output, "FAIL open embedded PostgreSQL client: %v\n", err)
			return 1
		}
		defer closer.Close()
		record, explanation, err := client.ExplainRule(ctx, args[0])
		if err != nil {
			fmt.Fprintf(output, "FAIL explain Rule: %v\n", err)
			return 1
		}
		return printJSON(output, map[string]any{
			"rule": record, "explanation": explanation,
		})
	}
	endpoint := agentURL + "/v1/rules/" + url.PathEscape(args[0]) + "/explain"
	request, err := http.NewRequest(http.MethodPost, endpoint, bytes.NewReader(nil))
	if err != nil {
		fmt.Fprintf(output, "FAIL build explain request: %v\n", err)
		return 2
	}
	if token := getenv("RHINOQ_AGENT_TOKEN"); token != "" {
		request.Header.Set("Authorization", "Bearer "+token)
	}
	response, err := (&http.Client{Timeout: 35 * time.Second}).Do(request)
	if err != nil {
		fmt.Fprintf(output, "FAIL call optional HTTP Gateway: %v\n", err)
		return 1
	}
	defer response.Body.Close()
	if _, err := io.Copy(output, response.Body); err != nil {
		fmt.Fprintf(output, "\nFAIL read Agent response: %v\n", err)
		return 1
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return 1
	}
	return 0
}

// doctorFlags reads doctor's arguments.
//
// --report is the escape hatch from the exit code. It replaces --ci, which had
// the polarity backwards: a preflight that exits 0 while printing FAIL is one a
// pipeline silently passes, and --ci had to be remembered to make it honest.
// Failing by default means the mistake is a pipeline that stops, not one that
// ships.
//
// --ci is still accepted. Every pipeline that already asks for a gate keeps
// working and gets the behaviour it asked for; deprecating it is a note in the
// output, not a broken deployment. An argument that is neither is a usage
// error, so a mistyped --report is loud rather than silently ignored.
func doctorFlags(args []string) (reportOnly, deprecatedCI bool, invalid string) {
	for _, arg := range args {
		switch arg {
		case "--report":
			reportOnly = true
		case "--ci":
			deprecatedCI = true
		default:
			return false, false, arg
		}
	}
	return reportOnly, deprecatedCI, ""
}

// runDoctor reports setup, runtime and safety findings and returns the process
// exit code. A FAIL is an error unless --report asks for the report alone.
func runDoctor(reportOnly bool) int {
	c, err := config.LoadFromEnv(os.Getenv)
	if err != nil {
		fmt.Println("FAIL configuration")
		fmt.Printf("  %v\n", err)
		return 1
	}

	failures, warnings := 0, 0
	// The Node SDK ships a command with the same name that checks the isolated
	// Task profile only. Saying which one is running here stops a PASS from one
	// being read as a PASS from the other.
	fmt.Println("rhinoq doctor · runtime plane: configuration, fencing, timing, PostgreSQL, migrations")
	fmt.Println("  (npx rhinoq doctor checks the Node Task profile and local Rule files instead)")
	fmt.Println()
	fmt.Println("Configuration")
	fmt.Println("  PASS runtime configuration is valid")
	fmt.Printf("       concurrency=%d prefetch=%.1f max_claim_batch=%d\n", c.Concurrency, c.PrefetchFactor, c.MaxClaimBatch)
	fmt.Printf("       lease=%s heartbeat=%s poll=%s..%s\n", c.LeaseDuration, c.HeartbeatEvery, c.PollInterval, c.MaxPollInterval)
	fmt.Printf("       shutdown_grace=%s cancel_grace=%s reaper=%s\n", c.ShutdownGrace, c.CancelGrace, c.ReaperInterval)
	fmt.Printf("       reap_batch=%d reap_budget=%s\n", c.ReapBatchLimit, c.ReapSweepBudget)

	fmt.Println("Fencing")
	if c.WorkerName == "" {
		warnings++
		fmt.Println("  WARN RHINOQ_WORKER_NAME is empty")
		fmt.Println("       The worker falls back to hostname-pid. Epoch fencing still protects")
		fmt.Println("       writes, but an explicit unique name makes logs and incidents clearer.")
		fmt.Println("       Fix: set RHINOQ_WORKER_NAME uniquely per process.")
	} else {
		fmt.Printf("  PASS worker identity is %s\n", c.WorkerName)
	}

	fmt.Println("Timing")
	if c.HeartbeatEvery*3 > c.LeaseDuration {
		warnings++
		fmt.Printf("  WARN heartbeat %s leaves little room inside a %s lease\n", c.HeartbeatEvery, c.LeaseDuration)
		fmt.Println("       One slow renewal can expire the lease while the handler is running,")
		fmt.Println("       and the job is then handed to a second worker.")
		fmt.Println("       Fix: keep RHINOQ_HEARTBEAT_EVERY at or below a third of the lease.")
	} else {
		fmt.Println("  PASS heartbeat has room to renew before the lease expires")
	}
	if c.ReaperInterval > c.LeaseDuration {
		warnings++
		fmt.Printf("  WARN reaper runs every %s but leases last %s\n", c.ReaperInterval, c.LeaseDuration)
		fmt.Println("       Crashed work waits for the sweep, not for the lease, so recovery is")
		fmt.Println("       slower than it looks. Fix: set RHINOQ_REAPER_INTERVAL below the lease.")
	} else {
		fmt.Println("  PASS expired leases are swept at least once per lease period")
	}

	fmt.Println("Database")
	if c.DatabaseURL == "" {
		failures++
		fmt.Println("  FAIL RHINOQ_DATABASE_URL is empty")
		fmt.Println("       Without it only the in-memory store can start, which loses every job")
		fmt.Println("       when the process exits.")
		fmt.Println("       Fix: export RHINOQ_DATABASE_URL=postgres://user:pass@host:5432/db")
		fmt.Println("       Verify: rhinoq doctor")
	} else {
		dbCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		db, err := openDatabase(dbCtx, os.Getenv)
		if err != nil {
			failures++
			fmt.Printf("  FAIL cannot connect to PostgreSQL: %v\n", err)
			fmt.Println("       Fix: verify RHINOQ_DATABASE_URL, network access and TLS settings.")
		} else {
			defer db.Close()
			fmt.Println("  PASS PostgreSQL connection is healthy")
			var roleName string
			var isSuperuser bool
			if err := db.QueryRowContext(dbCtx, `
				SELECT current_user, rolsuper
				FROM pg_roles
				WHERE rolname = current_user`).Scan(&roleName, &isSuperuser); err != nil {
				warnings++
				fmt.Printf("  WARN cannot inspect PostgreSQL role: %v\n", err)
				fmt.Println("       Verify the connection uses a restricted read-only role before evaluating Rules.")
			} else if isSuperuser {
				warnings++
				fmt.Printf("  WARN PostgreSQL role %s is a superuser\n", roleName)
				fmt.Println("       Rule SQL runs in a read-only transaction, but production still needs a restricted read-only role.")
				fmt.Println("       Fix: configure RHINOQ_DATABASE_URL with the dedicated Rule role described in docs/postgres.md.")
			} else {
				fmt.Printf("  PASS PostgreSQL role %s is not a superuser\n", roleName)
			}
			runner, err := migrations.NewRunner(db)
			if err != nil {
				failures++
				fmt.Printf("  FAIL migration catalog: %v\n", err)
			} else {
				statuses, err := runner.Status(dbCtx)
				if err != nil {
					failures++
					fmt.Printf("  FAIL migration state: %v\n", err)
					fmt.Println("       Fix: run `rhinoq migrate plan`, review it, then `rhinoq migrate apply`.")
				} else if pending := migrations.PendingCount(statuses); pending > 0 {
					failures++
					fmt.Printf("  FAIL %s\n", migrations.Summary(statuses))
					fmt.Println("       Fix: run `rhinoq migrate plan`, review it, then `rhinoq migrate apply`.")
				} else {
					fmt.Printf("  PASS %s\n", migrations.Summary(statuses))
				}
			}
		}
	}

	fmt.Printf("\n%d failing, %d warning\n", failures, warnings)
	if failures > 0 {
		if reportOnly {
			// --report is for a human reading the output, where the exit code
			// is not what they are looking at.
			fmt.Println("Exit code suppressed by --report. Drop it to fail on a FAIL.")
			return 0
		}
		return 1
	}
	return 0
}

func runInit(args []string, output io.Writer) int {
	apply := false
	integrityOnly := false
	for _, arg := range args {
		switch arg {
		case "--apply":
			apply = true
		case "--integrity-only":
			integrityOnly = true
		default:
			fmt.Fprintf(output, "FAIL unknown init option %q\n", arg)
			fmt.Fprintln(output, "Usage: rhinoq init [--integrity-only] [--apply]")
			return 2
		}
	}
	fmt.Fprintln(output, "RhinoQ initialization plan")
	fmt.Fprintln(output, "  - create rhinoq.config.env.example")
	if integrityOnly {
		fmt.Fprintln(output, "  - configure PostgreSQL for Rules, scans and Findings")
		fmt.Fprintln(output, "  - do not configure or start a queue worker")
		fmt.Fprintln(output, "  - next: migrate, register one Rule, then run rhinoq scan")
	} else {
		fmt.Fprintln(output, "  - configure embedded worker, scheduler and PostgreSQL settings")
		fmt.Fprintln(output, "  - next: rhinoq migrate plan")
	}
	if !apply {
		fmt.Fprintln(output, "No files changed. Re-run with --apply to apply this plan.")
		return 0
	}
	content := "RHINOQ_DATABASE_URL=\n"
	if !integrityOnly {
		content += "RHINOQ_WORKER_NAME=worker-1\n" +
			"RHINOQ_CONCURRENCY=4\n" +
			"RHINOQ_PREFETCH_FACTOR=1.5\n" +
			"RHINOQ_MAX_CLAIM_BATCH=50\n" +
			"RHINOQ_LEASE_DURATION=1m\n" +
			"RHINOQ_HEARTBEAT_EVERY=20s\n" +
			"RHINOQ_POLL_INTERVAL=100ms\n" +
			"RHINOQ_MAX_POLL_INTERVAL=2s\n" +
			"RHINOQ_SHUTDOWN_GRACE=30s\n" +
			"RHINOQ_CANCEL_GRACE=10s\n" +
			"RHINOQ_REAPER_INTERVAL=30s\n" +
			"RHINOQ_MAX_WORKER_CRASHES=3\n"
	}
	file, err := os.OpenFile(
		"rhinoq.config.env.example",
		os.O_WRONLY|os.O_CREATE|os.O_EXCL,
		0644,
	)
	if err != nil {
		fmt.Fprintf(output, "FAIL apply: %v\n", err)
		fmt.Fprintln(output, "No file was overwritten. Move the existing file or merge the template manually.")
		return 1
	}
	if _, err := file.WriteString(content); err != nil {
		_ = file.Close()
		fmt.Fprintf(output, "FAIL apply: %v\n", err)
		return 1
	}
	if err := file.Close(); err != nil {
		fmt.Fprintf(output, "FAIL apply: %v\n", err)
		return 1
	}
	fmt.Fprintln(output, "Created rhinoq.config.env.example")
	return 0
}

func runHelp(args []string, output io.Writer) int {
	if len(args) == 0 {
		printRootHelp(output)
		return 0
	}
	if len(args) != 1 {
		fmt.Fprintln(output, "Usage: rhinoq help [command]")
		return 2
	}
	topic := strings.ToLower(strings.TrimSpace(args[0]))
	if topic == "ui" {
		topic = "workbench"
	}
	if !printCommandHelp(output, topic) {
		fmt.Fprintf(output, "FAIL unknown help topic %q\n\n", args[0])
		printRootHelp(output)
		return 2
	}
	return 0
}

func printRootHelp(output io.Writer) {
	fmt.Fprintln(output, "RhinoQ CLI")
	fmt.Fprintln(output)
	fmt.Fprintln(output, "Usage:")
	fmt.Fprintln(output, "  rhinoq <command> [options]")
	fmt.Fprintln(output, "  rhinoq help <command>")
	fmt.Fprintln(output)
	fmt.Fprintln(output, "Setup and safety")
	fmt.Fprintln(output, "  init        preview or write a local environment template")
	fmt.Fprintln(output, "  migrate     inspect or apply checksum-tracked PostgreSQL migrations")
	fmt.Fprintln(output, "  doctor      validate config, database connectivity and migration state")
	fmt.Fprintln(output)
	fmt.Fprintln(output, "Inspect and operate")
	fmt.Fprintln(output, "  jobs        list bounded, payload-free job summaries")
	fmt.Fprintln(output, "  queue       count, pause or resume one queue")
	fmt.Fprintln(output, "  attention   list work that needs a developer decision")
	fmt.Fprintln(output, "  findings    list and triage persistent business-integrity drift")
	fmt.Fprintln(output, "  rules       create, list, enable, disable, delete or schedule Rules")
	fmt.Fprintln(output, "  scan        verify one enabled Rule against real data, bounded")
	fmt.Fprintln(output, "  explain     inspect the PostgreSQL safety plan for one Rule")
	fmt.Fprintln(output, "  notify      configure and prove signed webhook/Slack destinations")
	fmt.Fprintln(output, "  retention   preview or reclaim evidence past its retention window")
	fmt.Fprintln(output)
	fmt.Fprintln(output, "Developer interface")
	fmt.Fprintln(output, "  workbench   open the loopback-only developer Workbench (read-only by default)")
	fmt.Fprintln(output, "  ui          alias for workbench")
	fmt.Fprintln(output)
	fmt.Fprintln(output, "Other")
	fmt.Fprintln(output, "  version     print the CLI development version")
	fmt.Fprintln(output, "  help        show this page or detailed help for one command")
	fmt.Fprintln(output)
	fmt.Fprintln(output, "Most commands require RHINOQ_DATABASE_URL. Run `rhinoq help <command>`")
	fmt.Fprintln(output, "for flags, write behavior and examples.")
	fmt.Fprintln(output, "Docs: https://github.com/madebyduy/RhinoQ/blob/main/docs/cli.md")
	fmt.Fprintln(output)
	fmt.Fprintln(output, "Exit codes: 0 success, 1 runtime/configuration failure, 2 invalid usage.")
}

func printCommandHelp(output io.Writer, topic string) bool {
	switch topic {
	case "help":
		fmt.Fprintln(output, `rhinoq help — terminal command reference

Usage:
  rhinoq help
  rhinoq help <command>
  rhinoq <command> --help

The first form lists commands. The second and third forms explain one command.
Help never connects to PostgreSQL and never changes files or data.`)
	case "init":
		fmt.Fprintln(output, `rhinoq init — prepare an environment template

Usage:
  rhinoq init
  rhinoq init --integrity-only
  rhinoq init --apply
  rhinoq init --integrity-only --apply

Without --apply, prints the files and next steps it would use. With --apply,
creates rhinoq.config.env.example in the current directory using safe defaults.
It never overwrites an existing file and does not create a database or apply
migrations.

--integrity-only writes only the PostgreSQL setting used by Rules, scans and
Findings. It does not configure a worker, claim loop, lease reaper or recovery
executor.

Next:
  copy the values into your environment
  rhinoq migrate plan
  rhinoq migrate apply
  rhinoq doctor`)
	case "migrate":
		fmt.Fprintln(output, `rhinoq migrate — manage the RhinoQ PostgreSQL schema

Usage:
  rhinoq migrate plan
  rhinoq migrate status
  rhinoq migrate sql
  rhinoq migrate apply

Actions:
  plan    show applied and pending migrations; read-only
  status  show the same authoritative schema state; read-only
  sql     print pending SQL for DBA review; read-only
  apply   verify checksums, take an advisory lock and apply pending versions

Required:
  RHINOQ_DATABASE_URL

Production flow:
  rhinoq migrate plan
  rhinoq migrate sql > rhinoq-pending.sql
  rhinoq migrate apply
  rhinoq doctor

Apply refuses checksum drift, version gaps, a newer schema and untracked RhinoQ
objects. It does not guess or automatically repair a migration baseline.`)
	case "doctor":
		fmt.Fprintln(output, `rhinoq doctor — validate a deployment before it handles work

Usage:
  rhinoq doctor
  rhinoq doctor --report

Checks typed runtime configuration, worker identity, lease/heartbeat/reaper
timing, PostgreSQL connectivity and migration state. It never applies a
migration.

The Node SDK ships a command with the same name. "npx rhinoq doctor" checks the
isolated Task profile, local Rule files and client packages; it does not look at
fencing, timing, the reaper or RhinoQ migration state. Before a pilot, run both.

Any FAIL returns exit code 1, so putting this in a pipeline is enough to stop a
deployment. A WARN never changes the exit code. --report prints the same
diagnosis and always exits 0, for a human reading the output rather than a gate.

--ci used to be required to make a FAIL fail. It is now the default: a preflight
whose default is to exit 0 while printing FAIL is one a pipeline quietly passes.
--ci is still accepted and does nothing, so an existing pipeline keeps working;
it prints a deprecation note. Any other argument is a usage error (exit 2), so a
mistyped --report cannot silently disable the gate.

Required for database checks:
  RHINOQ_DATABASE_URL

Example:
  rhinoq doctor
  rhinoq doctor --report`)
	case "jobs":
		fmt.Fprintln(output, `rhinoq jobs — inspect jobs without exporting payloads

Usage:
  rhinoq jobs list [flags]

Flags:
  --queue <name>           filter by queue/job name
  --states <csv>           pending,leased,retry_wait,blocked,dead,succeeded,cancelled
  --limit <n>              maximum rows, default 50, maximum 1000
  --offset <n>             pagination offset, default 0
  --json                   emit machine-readable JSON

Examples:
  rhinoq jobs list --queue generate-report --states pending,blocked,dead
  rhinoq jobs list --states dead --limit 100 --json

This command is read-only. Job payloads are deliberately absent from list
results.`)
	case "queue":
		fmt.Fprintln(output, `rhinoq queue — inspect or control one queue

Usage:
  rhinoq queue counts <name>
  rhinoq queue pause <name>
  rhinoq queue resume <name>

Actions:
  counts  show counts for every job state; read-only
  pause   stop future claims; already-running handlers continue
  resume  allow workers to claim the queue again

Examples:
  rhinoq queue counts generate-report
  rhinoq queue pause generate-report
  rhinoq queue resume generate-report

Pause and resume write queue-control state in PostgreSQL. They do not cancel or
terminate work that already owns a lease.`)
	case "attention":
		fmt.Fprintln(output, `rhinoq attention — show the developer decision inbox

Usage:
  rhinoq attention [flags]

Flags:
  --queue <name>  optional queue filter
  --limit <n>     maximum rows, default 50
  --offset <n>    pagination offset, default 0
  --json          emit machine-readable JSON

The inbox combines dead jobs, blocked executions, uncertain effects, outcome
mismatches and live persistent Findings. It is read-only and omits payloads.

Examples:
  rhinoq attention
  rhinoq attention --queue generate-report --limit 100 --json`)
	case "findings":
		fmt.Fprintln(output, `rhinoq findings — inspect and triage business-integrity drift

Usage:
  rhinoq findings list [flags]
  rhinoq findings acknowledge <identity flags>
  rhinoq findings resolve <identity flags> --reason <text>
  rhinoq findings ignore <identity flags> --until <duration> --reason <text>
  rhinoq findings false-positive <identity flags> --until <duration> --reason <text>

List flags:
  --rule <id>                 filter by Rule
  --subject-type <type>       filter by business subject type
  --subject <id>              filter by business subject id
  --statuses <csv>            default open,regressed,acknowledged
  --include-suppressed        include active suppressions
  --limit <n> --offset <n>    bounded pagination
  --json                      machine-readable output

Identity flags required by every transition:
  --rule --subject-type --subject --version --actor

Semantics:
  acknowledge     record ownership/awareness; future violations remain visible
  resolve         record that the underlying business state was repaired
  ignore          suppress the exact Finding until the requested duration
  false-positive  suppress it as an invalid invariant result for a duration

Every transition is persisted. Resolve, ignore and false-positive require a
reason; suppressions also require a positive duration such as 24h.`)
	case "scan":
		fmt.Fprintln(output, `rhinoq scan — verify one enabled Rule against real data

Usage:
  rhinoq scan <rule-id> [flags]

Flags:
  --subject <id>     verify a single business subject instead of walking all
  --cursor <c>       resume an incomplete scan from a previous run
  --max-pages <n>    page budget for this run (default 100, maximum 10000)
  --timeout <d>      wall-clock budget for this run (default 2m)
  --json             print the summary as JSON

This is the shortest path to a first Finding. It needs no queue, no worker and
no cutover: an enabled Rule and a database connection are enough.

Scan reads business data and writes only observations and Findings. It starts
no worker, claims no jobs and performs no repair. A Finding states that
something is wrong; deciding what to do about it stays with an operator and is
recorded through rhinoq findings.

The run is bounded twice, by --max-pages and by --timeout, and each page is
bounded by the Rule's own limit. Stopping on either budget is a result, not a
failure: the observations already made stand, and the printed cursor resumes
the rest.

Examples:
  rhinoq scan completed-report-has-output
  rhinoq scan completed-report-has-output --subject report_3912
  rhinoq scan completed-report-has-output --max-pages 5 --json`)
	case "rules":
		fmt.Fprintln(output, `rhinoq rules — operate deterministic integrity Rules

Usage:
  rhinoq rules list [flags]
  rhinoq rules create <rule-id> --query-file <path> --subject-type <type> [flags]
  rhinoq rules enable <rule-id>
  rhinoq rules disable <rule-id>
  rhinoq rules delete <rule-id> [--version n] [--purge-findings] [--apply]
  rhinoq rules run [flags]

List flags:
  --scope <job|table>  filter by scope
  --statuses <csv>     filter by draft,enabled,disabled status
  --limit <n>          default 100
  --offset <n>         default 0
  --json               machine-readable output

Create flags:
  --query-file <path>        the Rule SELECT; required
  --subject-type <type>      business subject type; required
  --name <text>              human-readable name; defaults to the id
  --scope <table|job>        default table
  --job-name <name>          required for job scope
  --baseline <RFC3339>       table Rule baseline; defaults to now
  --every <duration>         evaluation interval; default 5m
  --within <duration>        grace before a job subject is checked; default 0
  --cursor <subject|changed> how a table Rule walks; default subject
  --on-unknown <retry|finding>  what an inconclusive check does; default retry
  --unknown-grace <duration> unknown streak before a Finding opens; default 0
  --max-rows <n>             rows per page; default 500
  --statement-timeout <dur>  PostgreSQL statement timeout; default 5s
  --max-plan-cost <n>        Explain gate budget; default 100000
  --max-seq-scan-rows <n>    Explain gate budget; default 10000
  --force                    append a version even though the definition changed
  --json                     machine-readable output

Delete flags:
  --version <n>        remove one version instead of every version
  --purge-findings     also discard Findings and their lifecycle history
  --apply              perform the plan; without it nothing is deleted

Create registers a new immutable version and leaves it in draft. Re-creating an
existing Rule prints what changed and refuses without --force, because a new
version does not reopen Findings recorded against the old one.

Enable first runs the PostgreSQL Explain safety gate. Disable prevents future
claims but does not corrupt a page already leased.

Delete previews by default and removes the definition, its explain evidence,
its schedule and its subject outcomes. It refuses an enabled Rule — disable it
first — and refuses a Rule that owns Findings unless --purge-findings says to
discard those operator decisions too.

"rules run" is long-lived; stop it with Ctrl+C/SIGTERM for graceful shutdown.

Scheduler flags:
  --owner <name>          unique scheduler identity; defaults to hostname/pid
  --poll <duration>       idle poll interval; default 1s
  --lease <duration>      page lease; default 1m
  --error-backoff <dur>   retry delay after evaluation error; default 30s
  --batch <n>             maximum Rules claimed per cycle; default 4

Examples:
  rhinoq rules create completed-report-has-output \
    --query-file .rhinoq/rules/completed-report-has-output.sql \
    --subject-type report --every 5m
  rhinoq rules delete probe-rule
  rhinoq rules delete probe-rule --apply`)
	case "retention":
		fmt.Fprintln(output, `rhinoq retention — reclaim evidence that has outlived its window

Usage:
  rhinoq retention prune [flags]

Flags:
  --older-than <age>  age at which evidence becomes prunable; default 90d
                      accepts 90d, 720h or any Go duration; minimum 24h
  --rule <id>         narrow subject outcomes and finding history to one Rule
  --batch <n>         rows deleted per statement; default 5000
  --apply             perform the plan; without it nothing is deleted
  --json              machine-readable output

Prune previews by default, exactly like rhinoq rules delete.

What it removes:
  rhinoq_subject_outcomes         passing observations not seen since the cutoff
  rhinoq_finding_events           history of Findings already resolved
  rhinoq_notification_deliveries  settled delivery ledger entries

What it never removes: an open Finding, a pending delivery, a repair, a
ProviderOperation or its evidence. Retention must outlive the longest provider
dispute, audit and repair window you are subject to; RhinoQ does not choose
that period for you.

Every delete is bounded by --batch and runs as its own statement, because an
unbounded DELETE against the table a running scan is writing to is how a
retention job becomes the outage it was meant to prevent.

PostgreSQL reuses the freed space for new rows. Run VACUUM, or VACUUM FULL in a
maintenance window, to return it to the filesystem.

Example:
  rhinoq retention prune --older-than 90d
  rhinoq retention prune --older-than 90d --apply`)
	case "notify":
		fmt.Fprintln(output, `rhinoq notify — configure where Findings are delivered

Usage:
  rhinoq notify add <name> --webhook <url> [--secret-env VAR] [flags]
  rhinoq notify add <name> --slack <url> [flags]
  rhinoq notify list [--json]
  rhinoq notify remove <name>
  rhinoq notify test <name>
  rhinoq notify send <name> --rule <id> --subject-type <type> --subject <id> --version <n>

Add flags:
  --kind <webhook|slack>  destination type; default webhook
  --url <url>             endpoint, stored in the registry file
  --url-env <VAR>         endpoint read from the environment instead
  --secret-env <VAR>      environment variable holding the HMAC secret
  --timeout <duration>    per-delivery timeout; default 10s
  --grace <duration>      delay a first notification; a Finding that clears
                          inside the window never reaches a person
  --include-evidence      send Finding evidence; it may contain business data
  --link-base <url>       base URL used to build an openable Finding link
  --replace               overwrite an existing destination with this name

Destinations live in .rhinoq/notifications.json, or the path in
RHINOQ_NOTIFY_CONFIG. No secret is ever written there: the file records the
name of an environment variable and the value is read at send time, so a
registry that leaks is a list of URLs rather than working credentials.

"notify test" sends one synthetic signed event and writes nothing - no Finding,
no delivery record, no database connection. It exists because a signed webhook
is the one part of this system that cannot be verified by reading code: the
secret, the URL, the receiver's signature check and its TLS all have to line up
at the far end.

"notify send" delivers a real Finding through the durable delivery ledger, so
repeating it for the same event and destination reports "deduplicated" rather
than paging somebody twice.

Automatic multi-node scheduling is not implemented in this prerelease; call
send from your own scheduler or the Rule scheduler host.

Example:
  export RHINOQ_NOTIFY_SECRET_OPS="$(openssl rand -hex 32)"
  rhinoq notify add ops --webhook https://example.com/hooks/rhinoq --secret-env RHINOQ_NOTIFY_SECRET_OPS
  rhinoq notify test ops`)
	case "explain":
		fmt.Fprintln(output, `rhinoq explain — inspect one Rule before enabling it

Usage:
  rhinoq explain <rule-id>

By default this command connects directly through RHINOQ_DATABASE_URL. If
RHINOQ_AGENT_URL is set, it calls the optional authenticated HTTP Gateway and
uses RHINOQ_AGENT_TOKEN.

The result includes query shape, row/plan budgets and rejection reasons. Explain
is diagnostic; it does not enable or execute the Rule.

Example:
  rhinoq explain ready-report-has-output`)
	case "workbench":
		fmt.Fprintln(output, `rhinoq workbench — open the local developer interface

Usage:
  rhinoq workbench [flags]
  rhinoq ui [flags]

Flags:
  --demo           use built-in sample data; PostgreSQL is not required
  --port <n>       loopback port, default 8787; 0 selects an available port
  --queue <name>   open with an initial queue filter
  --no-open        print the URL without launching the system browser
  --actions        enable subject recheck and registered safe-repair callbacks

Live mode requires RHINOQ_DATABASE_URL and applied migrations. The server binds
only to 127.0.0.1, is read-only by default and never exposes job payloads.
Action mode never accepts arbitrary SQL or an unregistered mutation.

Examples:
  rhinoq workbench --demo
  rhinoq workbench --queue generate-report
  rhinoq workbench --no-open --port 0`)
	case "version":
		fmt.Fprintln(output, `rhinoq version — print the CLI version

Usage:
  rhinoq version

A build from source reports the development version. A release build stamps its
tag instead. Tagged prerelease binaries are available from GitHub Releases.`)
	default:
		return false
	}
	return true
}
