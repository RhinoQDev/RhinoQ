package config

import (
	"errors"
	"fmt"
	"os"
	"strconv"
	"time"
)

type Config struct {
	DatabaseURL    string
	WorkerName     string
	ClaimLimit     int
	Concurrency    int
	LeaseDuration  time.Duration
	PollInterval   time.Duration
	HeartbeatEvery time.Duration
	ReaperInterval time.Duration
}

func LoadFromEnv(getenv func(string) string) (Config, error) {
	if getenv == nil {
		getenv = os.Getenv
	}
	claimLimit, err := positiveInt(getenv, "RHINOQ_CLAIM_LIMIT", 10)
	if err != nil {
		return Config{}, err
	}
	concurrency, err := positiveInt(getenv, "RHINOQ_CONCURRENCY", 4)
	if err != nil {
		return Config{}, err
	}
	lease, err := positiveDuration(getenv, "RHINOQ_LEASE_DURATION", time.Minute)
	if err != nil {
		return Config{}, err
	}
	poll, err := positiveDuration(getenv, "RHINOQ_POLL_INTERVAL", time.Second)
	if err != nil {
		return Config{}, err
	}
	heartbeat, err := positiveDuration(getenv, "RHINOQ_HEARTBEAT_EVERY", lease/3)
	if err != nil {
		return Config{}, err
	}
	reaper, err := positiveDuration(getenv, "RHINOQ_REAPER_INTERVAL", time.Minute)
	if err != nil {
		return Config{}, err
	}
	config := Config{DatabaseURL: getenv("RHINOQ_DATABASE_URL"), WorkerName: getenv("RHINOQ_WORKER_NAME"), ClaimLimit: claimLimit, Concurrency: concurrency, LeaseDuration: lease, PollInterval: poll, HeartbeatEvery: heartbeat, ReaperInterval: reaper}
	return config, config.Validate()
}

func (c Config) Validate() error {
	if c.ClaimLimit <= 0 || c.Concurrency <= 0 {
		return errors.New("claim limit and concurrency must be positive")
	}
	if c.LeaseDuration <= 0 || c.PollInterval <= 0 || c.HeartbeatEvery <= 0 || c.ReaperInterval <= 0 {
		return errors.New("runtime durations must be positive")
	}
	if c.HeartbeatEvery >= c.LeaseDuration {
		return errors.New("heartbeat interval must be shorter than lease duration")
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
