package database

import (
	"runtime"
	"strings"
	"testing"
	"time"
)

func env(pairs map[string]string) func(string) string {
	return func(key string) string { return pairs[key] }
}

func TestDefaultsHoldIdleEqualToOpen(t *testing.T) {
	settings, err := SettingsFromEnv(env(nil), 0)
	if err != nil {
		t.Fatalf("resolve defaults: %v", err)
	}
	if settings.MaxOpenConns != settings.MaxIdleConns {
		t.Fatalf("idle must default to open so a burst does not reconnect: %+v", settings)
	}
	if settings.MaxOpenConns < 4 {
		t.Fatalf("default open conns must leave room for the reaper and watchdog: %d", settings.MaxOpenConns)
	}
	if settings.ConnMaxLifetime < settings.ConnMaxIdleTime {
		t.Fatalf("a connection must not be retired later than it is idled out: %+v", settings)
	}
}

func TestDefaultScalesWithMachineAndClampsAt32(t *testing.T) {
	settings, err := SettingsFromEnv(env(nil), 0)
	if err != nil {
		t.Fatalf("resolve defaults: %v", err)
	}
	want := 2 * runtime.GOMAXPROCS(0)
	switch {
	case want < 4:
		want = 4
	case want > 32:
		want = 32
	}
	if settings.MaxOpenConns != want {
		t.Fatalf("default open conns = %d, want %d", settings.MaxOpenConns, want)
	}
}

// A pool smaller than the concurrency it serves deadlocks the process against
// itself, so the reserve raises the floor rather than being advisory.
func TestReserveRaisesTheFloor(t *testing.T) {
	settings, err := SettingsFromEnv(env(nil), 64)
	if err != nil {
		t.Fatalf("resolve with reserve: %v", err)
	}
	if settings.MaxOpenConns < 64 {
		t.Fatalf("reserve 64 must not resolve below 64, got %d", settings.MaxOpenConns)
	}
}

func TestExplicitValueBelowReserveIsRefused(t *testing.T) {
	_, err := SettingsFromEnv(env(map[string]string{"RHINOQ_DB_MAX_OPEN_CONNS": "4"}), 32)
	if err == nil {
		t.Fatal("a pool of 4 serving 32 concurrent units must be refused, not silently accepted")
	}
}

func TestIdleIsClampedToOpen(t *testing.T) {
	settings, err := SettingsFromEnv(env(map[string]string{
		"RHINOQ_DB_MAX_OPEN_CONNS": "8",
		"RHINOQ_DB_MAX_IDLE_CONNS": "99",
	}), 0)
	if err != nil {
		t.Fatalf("resolve: %v", err)
	}
	if settings.MaxIdleConns != 8 {
		t.Fatalf("idle must clamp to open, got %d", settings.MaxIdleConns)
	}
}

func TestOverridesAreParsed(t *testing.T) {
	settings, err := SettingsFromEnv(env(map[string]string{
		"RHINOQ_DB_MAX_OPEN_CONNS":     "20",
		"RHINOQ_DB_MAX_IDLE_CONNS":     "6",
		"RHINOQ_DB_CONN_MAX_IDLE_TIME": "90s",
		"RHINOQ_DB_CONN_MAX_LIFETIME":  "10m",
	}), 0)
	if err != nil {
		t.Fatalf("resolve overrides: %v", err)
	}
	want := Settings{
		MaxOpenConns:    20,
		MaxIdleConns:    6,
		ConnMaxIdleTime: 90 * time.Second,
		ConnMaxLifetime: 10 * time.Minute,
	}
	if settings != want {
		t.Fatalf("settings = %+v, want %+v", settings, want)
	}
}

func TestRejectsUnusableValues(t *testing.T) {
	for name, pairs := range map[string]map[string]string{
		"zero open":        {"RHINOQ_DB_MAX_OPEN_CONNS": "0"},
		"negative open":    {"RHINOQ_DB_MAX_OPEN_CONNS": "-1"},
		"unlimited open":   {"RHINOQ_DB_MAX_OPEN_CONNS": "100000"},
		"non-numeric open": {"RHINOQ_DB_MAX_OPEN_CONNS": "lots"},
		"bad duration":     {"RHINOQ_DB_CONN_MAX_LIFETIME": "30"},
		"lifetime below idle": {
			"RHINOQ_DB_CONN_MAX_IDLE_TIME": "10m",
			"RHINOQ_DB_CONN_MAX_LIFETIME":  "1m",
		},
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := SettingsFromEnv(env(pairs), 0); err == nil {
				t.Fatalf("%s must be refused at startup, not discovered in production", name)
			}
		})
	}
}

func TestDescribeNamesEverySetting(t *testing.T) {
	settings := Settings{MaxOpenConns: 12, MaxIdleConns: 12, ConnMaxIdleTime: time.Minute, ConnMaxLifetime: time.Hour}
	got := settings.Describe()
	for _, want := range []string{"max_open=12", "max_idle=12", "conn_max_idle=1m0s", "conn_max_lifetime=1h0m0s"} {
		if !strings.Contains(got, want) {
			t.Fatalf("Describe() = %q, missing %q", got, want)
		}
	}
}
