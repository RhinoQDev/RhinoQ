// Command rhinoq-agent serves RhinoQ over HTTP. One Agent owns every
// correctness rule, so an application in any language only needs a thin client:
// enqueue, claim, report the result, record effects.
package main

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"log"
	"net/http"
	"os"
	"strconv"
	"time"

	"github.com/rhinoq/rhinoq/internal/interfaces/agent"
	"github.com/rhinoq/rhinoq/internal/runtime/shutdown"
	"github.com/rhinoq/rhinoq/pkg/rhinoq"
)

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func run() error {
	address := envOr("RHINOQ_AGENT_ADDRESS", ":8080")
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
  export RHINOQ_AGENT_TOKEN=$(openssl rand -hex 32)
  or, for local development only:
  export RHINOQ_AGENT_ALLOW_UNAUTHENTICATED=true

Verify
  curl -H "Authorization: Bearer $RHINOQ_AGENT_TOKEN" localhost:8080/health/ready`)
	}

	client, closeStore, err := openClient()
	if err != nil {
		return err
	}
	defer closeStore()

	server, err := agent.New(agent.Config{
		Client: client, Token: token, AllowUnauthenticated: open,
		HeartbeatInterval: durationOr("RHINOQ_AGENT_HEARTBEAT", 10*time.Second),
		MaxPayloadBytes:   intOr("RHINOQ_MAX_PAYLOAD_BYTES", 1<<20),
	})
	if err != nil {
		return err
	}

	ctx, stop := shutdown.Context(context.Background())
	defer stop()

	httpServer := &http.Server{
		Addr: address, Handler: server,
		ReadHeaderTimeout: 5 * time.Second,
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

// openClient builds the queue client. The PostgreSQL driver is the
// application's choice, so the Agent asks for a driver name instead of linking
// one in and locking every deployment to it.
func openClient() (*rhinoq.Client, func(), error) {
	url := os.Getenv("RHINOQ_DATABASE_URL")
	if url == "" {
		log.Println("rhinoq-agent: RHINOQ_DATABASE_URL is empty, running on the in-memory store (development only, nothing survives a restart)")
		return rhinoq.NewInMemory(), func() {}, nil
	}
	driver := envOr("RHINOQ_DATABASE_DRIVER", "pgx")
	db, err := sql.Open(driver, url)
	if err != nil {
		return nil, nil, fmt.Errorf(`RHINOQ_DRIVER_NOT_REGISTERED

What happened
  Opening the database with driver %q failed: %v

Why it matters
  Without a database the Agent cannot persist a single job.

What RhinoQ did
  The process did not start. Nothing was written.

How to fix
  RhinoQ does not link a PostgreSQL driver, so your build has to register one:
    import _ "github.com/jackc/pgx/v5/stdlib"
  Then set RHINOQ_DATABASE_DRIVER to its registered name (default "pgx").

Verify
  rhinoq doctor`, driver, err)
	}
	client, err := rhinoq.NewPostgres(db)
	if err != nil {
		_ = db.Close()
		return nil, nil, err
	}
	return client, func() { _ = db.Close() }, nil
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
