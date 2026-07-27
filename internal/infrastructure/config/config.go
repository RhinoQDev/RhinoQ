package config

import (
	"errors"
	"fmt"
	"os"
	"strconv"
	"time"
)

type Config struct {
	DatabaseURL string
	// WorkerName is written into every lease this process takes. Two workers
	// sharing a name cannot be told apart by the fencing check.
	WorkerName      string
	Concurrency     int
	PrefetchFactor  float64
	MaxClaimBatch   int
	LeaseDuration   time.Duration
	HeartbeatEvery  time.Duration
	PollInterval    time.Duration
	MaxPollInterval time.Duration
	ShutdownGrace   time.Duration
	CancelGrace     time.Duration
	ReaperInterval  time.Duration
	// MaxWorkerCrashes is how many times one job may take a worker down before
	// it is parked as a poison job.
	MaxWorkerCrashes int

	// ClaimLimit is kept for compatibility with existing deployments and is used
	// as MaxClaimBatch when that is unset. Batch size follows free execution
	// slots now, so a fixed claim limit is no longer the right knob.
	ClaimLimit int
}

const (
	maxPrefetchFactor = 3.0
	maxClaimBatchCap  = 1000
)

func LoadFromEnv(getenv func(string) string) (Config, error) {
	if getenv == nil {
		getenv = os.Getenv
	}
	claimLimit, err := positiveInt(getenv, "RHINOQ_CLAIM_LIMIT", 10)
	if err != nil {
		return Config{}, err
	}
	maxClaimBatch, err := positiveInt(getenv, "RHINOQ_MAX_CLAIM_BATCH", claimLimit)
	if err != nil {
		return Config{}, err
	}
	concurrency, err := positiveInt(getenv, "RHINOQ_CONCURRENCY", 4)
	if err != nil {
		return Config{}, err
	}
	prefetch, err := positiveFloat(getenv, "RHINOQ_PREFETCH_FACTOR", 1.5)
	if err != nil {
		return Config{}, err
	}
	crashes, err := positiveInt(getenv, "RHINOQ_MAX_WORKER_CRASHES", 3)
	if err != nil {
		return Config{}, err
	}
	lease, err := positiveDuration(getenv, "RHINOQ_LEASE_DURATION", time.Minute)
	if err != nil {
		return Config{}, err
	}
	poll, err := positiveDuration(getenv, "RHINOQ_POLL_INTERVAL", 100*time.Millisecond)
	if err != nil {
		return Config{}, err
	}
	maxPoll, err := positiveDuration(getenv, "RHINOQ_MAX_POLL_INTERVAL", 2*time.Second)
	if err != nil {
		return Config{}, err
	}
	heartbeat, err := positiveDuration(getenv, "RHINOQ_HEARTBEAT_EVERY", lease/3)
	if err != nil {
		return Config{}, err
	}
	shutdownGrace, err := positiveDuration(getenv, "RHINOQ_SHUTDOWN_GRACE", 30*time.Second)
	if err != nil {
		return Config{}, err
	}
	cancelGrace, err := positiveDuration(getenv, "RHINOQ_CANCEL_GRACE", 10*time.Second)
	if err != nil {
		return Config{}, err
	}
	reaper, err := positiveDuration(getenv, "RHINOQ_REAPER_INTERVAL", 30*time.Second)
	if err != nil {
		return Config{}, err
	}
	config := Config{
		DatabaseURL: getenv("RHINOQ_DATABASE_URL"), WorkerName: getenv("RHINOQ_WORKER_NAME"),
		Concurrency: concurrency, PrefetchFactor: prefetch, MaxClaimBatch: maxClaimBatch,
		LeaseDuration: lease, HeartbeatEvery: heartbeat, PollInterval: poll,
		MaxPollInterval: maxPoll, ShutdownGrace: shutdownGrace, CancelGrace: cancelGrace,
		ReaperInterval: reaper, MaxWorkerCrashes: crashes, ClaimLimit: claimLimit,
	}
	return config, config.Validate()
}

func (c Config) Validate() error {
	if c.Concurrency <= 0 || c.MaxClaimBatch <= 0 || c.MaxWorkerCrashes <= 0 {
		return errors.New("concurrency, claim batch and worker crash budget must be positive")
	}
	if c.MaxClaimBatch > maxClaimBatchCap {
		return fmt.Errorf("RHINOQ_MAX_CLAIM_BATCH must not exceed %d: a larger batch protects nothing and holds leases while jobs wait", maxClaimBatchCap)
	}
	if c.PrefetchFactor <= 0 || c.PrefetchFactor > maxPrefetchFactor {
		return fmt.Errorf("RHINOQ_PREFETCH_FACTOR must be between 0 and %.1f: prefetched jobs hold a lease while they wait for a slot", maxPrefetchFactor)
	}
	if c.LeaseDuration <= 0 || c.PollInterval <= 0 || c.HeartbeatEvery <= 0 || c.ReaperInterval <= 0 {
		return errors.New("runtime durations must be positive")
	}
	if c.MaxPollInterval < c.PollInterval {
		return errors.New("RHINOQ_MAX_POLL_INTERVAL must not be shorter than RHINOQ_POLL_INTERVAL")
	}
	if c.HeartbeatEvery >= c.LeaseDuration {
		return errors.New("heartbeat interval must be shorter than lease duration")
	}
	if c.ShutdownGrace <= 0 || c.CancelGrace <= 0 {
		return errors.New("shutdown and cancel grace periods must be positive")
	}
	return nil
}

func positiveInt(getenv func(string) string, key string, fallback int) (int, error) {
	raw := getenv(key)
	if raw == "" {
		return fallback, nil
	}
	value, err := strconv.Atoi(raw)
	if err != nil || value <= 0 {
		return 0, fmt.Errorf("%s must be a positive integer", key)
	}
	return value, nil
}

func positiveFloat(getenv func(string) string, key string, fallback float64) (float64, error) {
	raw := getenv(key)
	if raw == "" {
		return fallback, nil
	}
	value, err := strconv.ParseFloat(raw, 64)
	if err != nil || value <= 0 {
		return 0, fmt.Errorf("%s must be a positive number", key)
	}
	return value, nil
}

func positiveDuration(getenv func(string) string, key string, fallback time.Duration) (time.Duration, error) {
	raw := getenv(key)
	if raw == "" {
		return fallback, nil
	}
	value, err := time.ParseDuration(raw)
	if err != nil || value <= 0 {
		return 0, fmt.Errorf("%s must be a positive duration", key)
	}
	return value, nil
}
