package main

import (
	"context"
	"database/sql"
	"errors"
	"log"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	_ "github.com/jackc/pgx/v5/stdlib"
	"github.com/madebyduy/RhinoQ/pkg/rhinoq"
)

// This binary is a recovery/health sidecar, not a pretend generic business
// worker. Applications register their handlers and call Client.Run; a binary
// cannot safely infer those contracts from a database.
func main() {
	url := strings.TrimSpace(os.Getenv("RHINOQ_DATABASE_URL"))
	if url == "" {
		url = strings.TrimSpace(os.Getenv("DATABASE_URL"))
	}
	if url == "" {
		log.Fatal("RHINOQ_DATABASE_URL (or DATABASE_URL) is required; application workers must call Client.Run")
	}
	db, err := sql.Open("pgx", url)
	if err != nil {
		log.Fatal(err)
	}
	defer db.Close()
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if err := db.PingContext(ctx); err != nil {
		log.Fatal(err)
	}
	client, err := rhinoq.NewPostgres(db)
	if err != nil {
		log.Fatal(err)
	}
	config := rhinoq.WorkerConfig{
		ReaperInterval:     durationEnv("RHINOQ_WORKER_REAPER_INTERVAL", 30*time.Second),
		QueueWatchInterval: durationEnv("RHINOQ_WORKER_QUEUE_WATCH_INTERVAL", 30*time.Second),
		QueueNames:         splitEnv("RHINOQ_WORKER_QUEUES"),
	}
	config.OnQueueAlert = func(alert rhinoq.QueueAlert) {
		log.Printf("queue alert queue=%s kind=%s active=%t message=%s", alert.QueueName, alert.Kind, alert.Active, alert.Message)
	}
	if err := client.RunRecovery(ctx, config); err != nil && !errors.Is(err, context.Canceled) {
		log.Fatal(err)
	}
}

func durationEnv(name string, fallback time.Duration) time.Duration {
	value := strings.TrimSpace(os.Getenv(name))
	if value == "" {
		return fallback
	}
	duration, err := time.ParseDuration(value)
	if err != nil || duration <= 0 {
		log.Fatalf("%s must be a positive duration", name)
	}
	return duration
}

func splitEnv(name string) []string {
	var values []string
	for _, value := range strings.Split(os.Getenv(name), ",") {
		if value = strings.TrimSpace(value); value != "" {
			values = append(values, value)
		}
	}
	return values
}
