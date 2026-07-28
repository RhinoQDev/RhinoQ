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

	"github.com/rhinoq/rhinoq/internal/infrastructure/config"
	"github.com/rhinoq/rhinoq/internal/infrastructure/migrations"
)

func main() {
	command := "help"
	if len(os.Args) > 1 {
		command = os.Args[1]
	}
	switch command {
	case "help", "-h", "--help":
		printHelp()
	case "doctor":
		os.Exit(runDoctor(ciMode()))
	case "init":
		runInit()
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
	case "rules":
		os.Exit(runRules(os.Args[2:], os.Getenv, os.Stdout))
	case "explain":
		os.Exit(runExplain(os.Args[2:], os.Getenv, os.Stdout))
	case "version":
		fmt.Println("rhinoq 0.1.0-dev")
	default:
		fmt.Fprintf(os.Stderr, "FAIL unknown command %q\n\n", command)
		printHelp()
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

func ciMode() bool {
	for _, arg := range os.Args[2:] {
		if arg == "--ci" {
			return true
		}
	}
	return false
}

// runDoctor reports setup, runtime and safety findings. It returns the process
// exit code: in CI mode a failure is an error, otherwise it is a report.
func runDoctor(ci bool) int {
	c, err := config.LoadFromEnv(os.Getenv)
	if err != nil {
		fmt.Println("FAIL configuration")
		fmt.Printf("  %v\n", err)
		return 1
	}

	failures, warnings := 0, 0
	fmt.Println("Configuration")
	fmt.Println("  PASS runtime configuration is valid")
	fmt.Printf("       concurrency=%d prefetch=%.1f max_claim_batch=%d\n", c.Concurrency, c.PrefetchFactor, c.MaxClaimBatch)
	fmt.Printf("       lease=%s heartbeat=%s poll=%s..%s\n", c.LeaseDuration, c.HeartbeatEvery, c.PollInterval, c.MaxPollInterval)
	fmt.Printf("       shutdown_grace=%s cancel_grace=%s reaper=%s\n", c.ShutdownGrace, c.CancelGrace, c.ReaperInterval)

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
	if ci && failures > 0 {
		return 1
	}
	return 0
}

func runInit() {
	apply := len(os.Args) > 2 && os.Args[2] == "--apply"
	fmt.Println("RhinoQ initialization plan")
	fmt.Println("  - create rhinoq.config.env.example")
	fmt.Println("  - configure embedded worker, scheduler and PostgreSQL settings")
	fmt.Println("  - next: rhinoq migrate plan")
	if !apply {
		fmt.Println("No files changed. Re-run with --apply to apply this plan.")
		return
	}
	content := "RHINOQ_DATABASE_URL=\n" +
		"RHINOQ_WORKER_NAME=worker-1\n" +
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
	file, err := os.OpenFile(
		"rhinoq.config.env.example",
		os.O_WRONLY|os.O_CREATE|os.O_EXCL,
		0644,
	)
	if err != nil {
		fmt.Printf("FAIL apply: %v\n", err)
		fmt.Println("No file was overwritten. Move the existing file or merge the template manually.")
		os.Exit(1)
	}
	if _, err := file.WriteString(content); err != nil {
		_ = file.Close()
		fmt.Printf("FAIL apply: %v\n", err)
		os.Exit(1)
	}
	if err := file.Close(); err != nil {
		fmt.Printf("FAIL apply: %v\n", err)
		os.Exit(1)
	}
	fmt.Println("Created rhinoq.config.env.example")
}

func printHelp() {
	fmt.Println("RhinoQ CLI")
	fmt.Println("  rhinoq init                         show initialization plan")
	fmt.Println("  rhinoq init --apply                 write the environment template")
	fmt.Println("  rhinoq migrate [plan|status|sql|apply]  manage PostgreSQL schema safely")
	fmt.Println("  rhinoq doctor [--ci]                check config, database and schema")
	fmt.Println("  rhinoq jobs list                    inspect jobs without payload export")
	fmt.Println("  rhinoq queue <counts|pause|resume>  control one queue")
	fmt.Println("  rhinoq attention                    show the operator inbox")
	fmt.Println("  rhinoq findings [action]            list or triage business drift")
	fmt.Println("  rhinoq rules <list|enable|disable|run>  manage integrity Rules")
	fmt.Println("  rhinoq explain <id>                 Explain a Rule using PostgreSQL")
	fmt.Println("  rhinoq version                      print version")
}
