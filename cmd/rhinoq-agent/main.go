// Command rhinoq-agent serves RhinoQ over HTTP. One Agent owns every
// correctness rule, so an application in any language only needs a thin client:
// enqueue, claim, report the result, record effects.
package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"

	_ "github.com/jackc/pgx/v5/stdlib"
	outboxadapter "github.com/madebyduy/RhinoQ/internal/adapters/outbox"
	postgresadapter "github.com/madebyduy/RhinoQ/internal/adapters/postgres"
	// Aliased: run() already has a local named `database` for the *sql.DB.
	dbpool "github.com/madebyduy/RhinoQ/internal/infrastructure/database"
	"github.com/madebyduy/RhinoQ/internal/interfaces/agent"
	"github.com/madebyduy/RhinoQ/internal/runtime/scheduler"
	"github.com/madebyduy/RhinoQ/internal/runtime/shutdown"
	"github.com/madebyduy/RhinoQ/pkg/rhinoq"
)

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func run() error {
	address := envOr("RHINOQ_AGENT_ADDRESS", "127.0.0.1:8080")
	token := os.Getenv("RHINOQ_AGENT_TOKEN")
	open := os.Getenv("RHINOQ_AGENT_ALLOW_UNAUTHENTICATED") == "true"
	if token == "" && !open {
		return errors.New(`RHINOQ_AGENT_UNCONFIGURED

What happened
  Neither RHINOQ_AGENT_TOKEN nor RHINOQ_AGENT_ALLOW_UNAUTHENTICATED is set.

Why it matters
  The Agent can enqueue, cancel and replay work for every queue behind it.
  Starting it without authentication would expose all of that.

What RhinoQ did
  The process did not start. Nothing is listening.

How to fix
  Bash/zsh:
  export RHINOQ_AGENT_TOKEN=$(openssl rand -hex 32)
  or, for local development only:
  export RHINOQ_AGENT_ALLOW_UNAUTHENTICATED=true

  PowerShell:
  $bytes = New-Object byte[] 32
  [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
  $env:RHINOQ_AGENT_TOKEN = [Convert]::ToBase64String($bytes)
  or, for local development only:
  $env:RHINOQ_AGENT_ALLOW_UNAUTHENTICATED = 'true'

Verify
  curl -H "Authorization: Bearer $RHINOQ_AGENT_TOKEN" localhost:8080/health/ready`)
	}
	if err := validateAgentAddress(address, open); err != nil {
		return err
	}

	client, database, closeStore, err := openClient()
	if err != nil {
		return err
	}
	defer closeStore()
	taskCredentials, err := taskCredentialsFromEnv()
	if err != nil {
		return err
	}
	repairRegistry, err := repairRegistryFromEnv()
	if err != nil {
		return err
	}

	server, err := agent.New(agent.Config{
		Client: client, Token: token, TenantID: os.Getenv("RHINOQ_TENANT_ID"), Role: os.Getenv("RHINOQ_AGENT_ROLE"), AllowUnauthenticated: open,
		TaskCredentials:   taskCredentials,
		HeartbeatInterval: durationOr("RHINOQ_AGENT_HEARTBEAT", 10*time.Second),
		MaxPayloadBytes:   intOr("RHINOQ_MAX_PAYLOAD_BYTES", 1<<20),
		RequestsPerSecond: floatOr("RHINOQ_AGENT_REQUESTS_PER_SECOND", 200),
		RequestBurst:      intOr("RHINOQ_AGENT_REQUEST_BURST", 400),
		// Zero means "derive it": one credential keeps the whole Gateway
		// budget, several split it. Set these when the split should not be
		// even — a Gateway whose console traffic is negligible next to its
		// worker traffic, for instance.
		PerCallerRequestsPerSecond: floatOr("RHINOQ_AGENT_REQUESTS_PER_SECOND_PER_CALLER", 0),
		PerCallerRequestBurst:      intOr("RHINOQ_AGENT_REQUEST_BURST_PER_CALLER", 0),
		RepairRegistry:             repairRegistry,
	})
	if err != nil {
		return err
	}

	ctx, stop := shutdown.Context(context.Background())
	defer stop()
	publisherErrors, err := startOutboxPublisher(ctx, database)
	if err != nil {
		return err
	}

	httpServer := &http.Server{
		Addr:              address,
		Handler:           server,
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       15 * time.Second,
		IdleTimeout:       60 * time.Second,
		MaxHeaderBytes:    32 << 10,
	}
	listening := make(chan error, 1)
	go func() {
		log.Printf("rhinoq-agent listening on %s (protocol %s)", address, agent.ProtocolVersion)
		listening <- httpServer.ListenAndServe()
	}()

	select {
	case err := <-listening:
		if errors.Is(err, http.ErrServerClosed) {
			return nil
		}
		return err
	case err := <-publisherErrors:
		return fmt.Errorf("retry outbox publisher stopped: %w", err)
	case <-ctx.Done():
	}

	// Readiness fails first so the orchestrator stops sending traffic, then the
	// server finishes the requests it already accepted.
	server.Drain()
	graceCtx, cancel := context.WithTimeout(context.Background(), durationOr("RHINOQ_AGENT_SHUTDOWN_GRACE", 20*time.Second))
	defer cancel()
	log.Println("rhinoq-agent draining")
	return httpServer.Shutdown(graceCtx)
}

func repairRegistryFromEnv() (*rhinoq.RepairRegistry, error) {
	raw := strings.TrimSpace(os.Getenv("RHINOQ_REPAIR_CALLBACKS_JSON"))
	if raw == "" {
		return nil, nil
	}
	var callbacks map[string]struct {
		URL               string `json:"url"`
		Secret            string `json:"secret"`
		Timeout           string `json:"timeout"`
		AllowInsecureHTTP bool   `json:"allowInsecureHTTP"`
	}
	if err := json.Unmarshal([]byte(raw), &callbacks); err != nil {
		return nil, errors.New("RHINOQ_REPAIR_CALLBACKS_JSON must be an object keyed by repair handler name")
	}
	registry := rhinoq.NewRepairRegistry()
	for name, config := range callbacks {
		timeout := 10 * time.Second
		if config.Timeout != "" {
			parsed, err := time.ParseDuration(config.Timeout)
			if err != nil || parsed <= 0 {
				return nil, fmt.Errorf("repair callback %q has an invalid timeout", name)
			}
			timeout = parsed
		}
		handler, err := rhinoq.NewHTTPRepairHandler(rhinoq.HTTPRepairHandlerOptions{
			URL: config.URL, Secret: config.Secret, Timeout: timeout,
			AllowInsecureHTTP: config.AllowInsecureHTTP,
		})
		if err != nil {
			return nil, fmt.Errorf("repair callback %q: %w", name, err)
		}
		if err := registry.Register(name, handler); err != nil {
			return nil, err
		}
	}
	return registry, nil
}

func floatOr(key string, fallback float64) float64 {
	raw := strings.TrimSpace(os.Getenv(key))
	if raw == "" {
		return fallback
	}
	value, err := strconv.ParseFloat(raw, 64)
	if err != nil || value <= 0 {
		return fallback
	}
	return value
}

func taskCredentialsFromEnv() ([]agent.TaskCredential, error) {
	raw := strings.TrimSpace(os.Getenv("RHINOQ_TASK_CREDENTIALS_JSON"))
	if raw == "" {
		return nil, nil
	}
	var credentials []agent.TaskCredential
	if err := json.Unmarshal([]byte(raw), &credentials); err != nil {
		return nil, errors.New("RHINOQ_TASK_CREDENTIALS_JSON must be a JSON array of ownerId/token objects")
	}
	return credentials, nil
}

func validateAgentAddress(address string, allowUnauthenticated bool) error {
	if !allowUnauthenticated {
		return nil
	}
	host, _, err := net.SplitHostPort(address)
	if err != nil {
		return fmt.Errorf("RHINOQ_AGENT_ADDRESS must be host:port: %w", err)
	}
	host = strings.Trim(host, "[]")
	if strings.EqualFold(host, "localhost") {
		return nil
	}
	ip := net.ParseIP(host)
	if ip == nil || !ip.IsLoopback() {
		return errors.New(
			"RHINOQ_AGENT_ALLOW_UNAUTHENTICATED may only bind to a loopback address",
		)
	}
	return nil
}

// openClient builds the queue client. The official Gateway binary registers
// pgx so the documented command works without a custom bootstrap. A custom
// build may register another database/sql driver and select it through
// RHINOQ_DATABASE_DRIVER.
func openClient() (*rhinoq.Client, *sql.DB, func(), error) {
	url := os.Getenv("RHINOQ_DATABASE_URL")
	if url == "" {
		log.Println("rhinoq-agent: RHINOQ_DATABASE_URL is empty, running on the in-memory store (development only, nothing survives a restart)")
		return rhinoq.NewInMemory(), nil, func() {}, nil
	}
	driver := envOr("RHINOQ_DATABASE_DRIVER", "pgx")
	db, err := sql.Open(driver, url)
	if err != nil {
		return nil, nil, nil, fmt.Errorf(`RHINOQ_DRIVER_NOT_REGISTERED

What happened
  Opening the database with driver %q failed: %v

Why it matters
  Without a database the Agent cannot persist a single job.

What RhinoQ did
  The process did not start. Nothing was written.

How to fix
  The official Gateway includes pgx. If RHINOQ_DATABASE_DRIVER names another
  driver, your custom build must register it:
    import _ "<database/sql driver package>"
  Otherwise remove the override and use the default "pgx".

Verify
  rhinoq doctor`, driver, err)
	}
	// The Gateway serves concurrent HTTP requests, so its reserve is the request
	// budget it is already rate-limited to rather than a worker concurrency.
	// Leaving the pool unbounded is how one traffic spike turns into
	// "too many clients already" for every process sharing this database.
	settings, err := dbpool.Tune(db, os.Getenv, 0)
	if err != nil {
		_ = db.Close()
		return nil, nil, nil, err
	}
	log.Printf("rhinoq-agent: postgres pool %s", settings.Describe())
	client, err := rhinoq.NewPostgres(db)
	if err != nil {
		_ = db.Close()
		return nil, nil, nil, err
	}
	return client, db, func() { _ = db.Close() }, nil
}

func startOutboxPublisher(ctx context.Context, db *sql.DB) (<-chan error, error) {
	url := strings.TrimSpace(os.Getenv("RHINOQ_RETRY_DISPATCH_URL"))
	if url == "" {
		return nil, nil
	}
	if db == nil {
		return nil, errors.New("RHINOQ_RETRY_DISPATCH_URL requires RHINOQ_DATABASE_URL; an in-memory outbox cannot recover after restart")
	}
	transport, err := outboxadapter.NewHTTPPublisher(outboxadapter.HTTPPublisherConfig{
		URL: url, Secret: os.Getenv("RHINOQ_RETRY_DISPATCH_SECRET"),
		Timeout: durationOr("RHINOQ_RETRY_DISPATCH_TIMEOUT", 10*time.Second),
	})
	if err != nil {
		return nil, err
	}
	store, err := postgresadapter.NewOutboxStore(db)
	if err != nil {
		return nil, err
	}
	publisher, err := scheduler.NewOutboxPublisher(scheduler.PublisherConfig{
		Store: store, Publisher: transport,
		BatchSize:    intOr("RHINOQ_RETRY_DISPATCH_BATCH_SIZE", 50),
		Interval:     durationOr("RHINOQ_RETRY_DISPATCH_INTERVAL", time.Second),
		ReclaimAfter: durationOr("RHINOQ_RETRY_DISPATCH_RECLAIM_AFTER", 5*time.Minute),
	})
	if err != nil {
		return nil, err
	}
	errors := make(chan error, 1)
	go func() { errors <- publisher.Run(ctx) }()
	return errors, nil
}

func envOr(key, fallback string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return fallback
}

func intOr(key string, fallback int) int {
	value, err := strconv.Atoi(os.Getenv(key))
	if err != nil || value <= 0 {
		return fallback
	}
	return value
}

func durationOr(key string, fallback time.Duration) time.Duration {
	value, err := time.ParseDuration(os.Getenv(key))
	if err != nil || value <= 0 {
		return fallback
	}
	return value
}
