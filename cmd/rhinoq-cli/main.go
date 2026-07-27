package main

import (
	"fmt"
	"os"

	"github.com/rhinoq/rhinoq/internal/infrastructure/config"
)

func main() {
	command := "help"
	if len(os.Args) > 1 {
		command = os.Args[1]
	}
	switch command {
	case "doctor":
		runDoctor()
	case "init":
		runInit()
	case "version":
		fmt.Println("rhinoq 0.1.0-dev")
	default:
		printHelp()
	}
}

func runDoctor() {
	c, err := config.LoadFromEnv(os.Getenv)
	if err != nil {
		fmt.Printf("FAIL config: %v\n", err)
		os.Exit(1)
	}
	fmt.Println("PASS runtime config")
	fmt.Printf("  claim_limit=%d concurrency=%d lease=%s heartbeat=%s\n", c.ClaimLimit, c.Concurrency, c.LeaseDuration, c.HeartbeatEvery)
	if c.DatabaseURL == "" {
		fmt.Println("WARN RHINOQ_DATABASE_URL is empty; production PostgreSQL client cannot start")
	} else {
		fmt.Println("PASS database URL is configured")
	}
}

func runInit() {
	apply := len(os.Args) > 2 && os.Args[2] == "--apply"
	fmt.Println("RhinoQ initialization plan")
	fmt.Println("  - create rhinoq.config.env.example")
	fmt.Println("  - document worker and PostgreSQL settings")
	if !apply {
		fmt.Println("No files changed. Re-run with --apply to apply this plan.")
		return
	}
	content := "RHINOQ_DATABASE_URL=\nRHINOQ_WORKER_NAME=worker-1\nRHINOQ_CLAIM_LIMIT=10\nRHINOQ_CONCURRENCY=4\nRHINOQ_LEASE_DURATION=1m\nRHINOQ_POLL_INTERVAL=1s\nRHINOQ_HEARTBEAT_EVERY=20s\nRHINOQ_REAPER_INTERVAL=1m\n"
	if err := os.WriteFile("rhinoq.config.env.example", []byte(content), 0644); err != nil {
		fmt.Printf("FAIL apply: %v\n", err)
		os.Exit(1)
	}
	fmt.Println("Created rhinoq.config.env.example")
}

func printHelp() {
	fmt.Println("RhinoQ CLI")
	fmt.Println("  rhinoq doctor       validate runtime configuration")
	fmt.Println("  rhinoq init          show initialization plan")
	fmt.Println("  rhinoq init --apply  apply initialization plan")
	fmt.Println("  rhinoq version       print version")
}
