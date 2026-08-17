// Package database owns the connection-pool shape for every RhinoQ process.
//
// It exists because `sql.Open` alone is a production incident waiting to
// happen, and all three binaries were doing exactly that. `database/sql`
// defaults `MaxOpenConns` to unlimited: enough workers and PostgreSQL starts
// refusing every connection with "too many clients already" — including
// connections from processes that share the database and have nothing to do
// with RhinoQ. It also defaults `MaxIdleConns` to 2, so a burst past two
// concurrent queries closes and reopens connections continuously, paying a TCP
// handshake, a TLS handshake and an authentication round trip for work that
// should have cost one round trip.
//
// The pool is infrastructure, not policy: nothing here knows what a Job is.
package database

import (
	"database/sql"
	"errors"
	"fmt"
	"runtime"
	"strconv"
	"strings"
	"time"
)

// Recommended bounds. These are not tuning advice for every deployment; they
// are the range in which a wrong value is a mistake rather than a choice.
const (
	minOpenConns = 2
	maxOpenConns = 512

	defaultConnMaxIdleTime = 5 * time.Minute
	defaultConnMaxLifetime = 30 * time.Minute
)

// Settings is the resolved pool shape. It is returned so a composition root can
// log it and `rhinoq doctor` can compare the total against `max_connections`.
type Settings struct {
	MaxOpenConns    int
	MaxIdleConns    int
	ConnMaxIdleTime time.Duration
	ConnMaxLifetime time.Duration
}

// Describe renders the settings for an operator, in the order they matter.
func (s Settings) Describe() string {
	return fmt.Sprintf(
		"max_open=%d max_idle=%d conn_max_idle=%s conn_max_lifetime=%s",
		s.MaxOpenConns, s.MaxIdleConns, s.ConnMaxIdleTime, s.ConnMaxLifetime,
	)
}

// Apply writes the settings onto a pool. It is separate from resolution so a
// test can assert the numbers without a database.
func (s Settings) Apply(db *sql.DB) {
	if db == nil {
		return
	}
	db.SetMaxOpenConns(s.MaxOpenConns)
	db.SetMaxIdleConns(s.MaxIdleConns)
	db.SetConnMaxIdleTime(s.ConnMaxIdleTime)
	db.SetConnMaxLifetime(s.ConnMaxLifetime)
}

// SettingsFromEnv resolves the pool shape.
//
// reserve is how many connections the caller knows it needs concurrently —
// worker concurrency, typically. It raises the floor rather than setting the
// value, because a pool smaller than the concurrency it serves deadlocks the
// process against itself: every slot waits for a connection that another slot
// is holding. A caller that does not know passes 0.
func SettingsFromEnv(getenv func(string) string, reserve int) (Settings, error) {
	if getenv == nil {
		getenv = func(string) string { return "" }
	}

	open, err := positiveInt(getenv, "RHINOQ_DB_MAX_OPEN_CONNS", defaultOpenConns(reserve))
	if err != nil {
		return Settings{}, err
	}
	if open < minOpenConns || open > maxOpenConns {
		return Settings{}, fmt.Errorf(
			"RHINOQ_DB_MAX_OPEN_CONNS must be between %d and %d, got %d",
			minOpenConns, maxOpenConns, open)
	}
	if reserve > 0 && open < reserve {
		return Settings{}, fmt.Errorf(
			"RHINOQ_DB_MAX_OPEN_CONNS is %d but this process runs %d concurrent units; "+
				"a pool smaller than its own concurrency deadlocks against itself",
			open, reserve)
	}

	// Idle defaults to open. This is the whole point: holding the connections
	// the process already proved it needs costs a few idle backends and saves a
	// full connect on every burst. ConnMaxIdleTime is what returns them when the
	// burst is over.
	idle, err := positiveInt(getenv, "RHINOQ_DB_MAX_IDLE_CONNS", open)
	if err != nil {
		return Settings{}, err
	}
	if idle > open {
		idle = open
	}

	idleTime, err := positiveDuration(getenv, "RHINOQ_DB_CONN_MAX_IDLE_TIME", defaultConnMaxIdleTime)
	if err != nil {
		return Settings{}, err
	}
	lifetime, err := positiveDuration(getenv, "RHINOQ_DB_CONN_MAX_LIFETIME", defaultConnMaxLifetime)
	if err != nil {
		return Settings{}, err
	}
	// A connection that never retires cannot follow a failover or a pooler
	// restart, and it pins one server-side backend's memory for the life of the
	// process.
	if lifetime < idleTime {
		return Settings{}, errors.New(
			"RHINOQ_DB_CONN_MAX_LIFETIME must be at least RHINOQ_DB_CONN_MAX_IDLE_TIME")
	}

	return Settings{
		MaxOpenConns:    open,
		MaxIdleConns:    idle,
		ConnMaxIdleTime: idleTime,
		ConnMaxLifetime: lifetime,
	}, nil
}

// Tune resolves the settings and applies them in one step, which is what a
// composition root wants.
func Tune(db *sql.DB, getenv func(string) string, reserve int) (Settings, error) {
	settings, err := SettingsFromEnv(getenv, reserve)
	if err != nil {
		return Settings{}, err
	}
	settings.Apply(db)
	return settings, nil
}

// defaultOpenConns scales with the machine and never drops below what the
// caller reserved. Two per CPU is the shape of a workload that waits on
// PostgreSQL more than it computes; the ceiling exists so a 96-core box does
// not quietly claim 192 backends by default.
func defaultOpenConns(reserve int) int {
	open := 2 * runtime.GOMAXPROCS(0)
	if open < 4 {
		open = 4
	}
	if open > 32 {
		open = 32
	}
	if reserve > 0 && open < reserve+2 {
		open = reserve + 2
	}
	return open
}

func positiveInt(getenv func(string) string, key string, fallback int) (int, error) {
	raw := strings.TrimSpace(getenv(key))
	if raw == "" {
		return fallback, nil
	}
	value, err := strconv.Atoi(raw)
	if err != nil || value <= 0 {
		return 0, fmt.Errorf("%s must be a positive integer, got %q", key, raw)
	}
	return value, nil
}

func positiveDuration(getenv func(string) string, key string, fallback time.Duration) (time.Duration, error) {
	raw := strings.TrimSpace(getenv(key))
	if raw == "" {
		return fallback, nil
	}
	value, err := time.ParseDuration(raw)
	if err != nil || value <= 0 {
		return 0, fmt.Errorf("%s must be a positive Go duration such as 30m, got %q", key, raw)
	}
	return value, nil
}
