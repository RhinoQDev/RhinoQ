package unit

import (
	"strings"
	"testing"
	"time"

	"github.com/madebyduy/RhinoQ/internal/infrastructure/config"
)

func TestConfigDefaultsAndValidation(t *testing.T) {
	c, err := config.LoadFromEnv(func(string) string { return "" })
	if err != nil {
		t.Fatal(err)
	}
	if c.MaxClaimBatch != 10 || c.Concurrency != 4 || c.HeartbeatEvery != 20*time.Second {
		t.Fatalf("unexpected defaults: %+v", c)
	}
	if c.PrefetchFactor != 1.5 || c.MaxWorkerCrashes != 3 || c.MaxPollInterval != 2*time.Second {
		t.Fatalf("unexpected runtime defaults: %+v", c)
	}
}

func TestConfigRejectsPrefetchThatWouldStrandLeases(t *testing.T) {
	_, err := config.LoadFromEnv(func(key string) string {
		if key == "RHINOQ_PREFETCH_FACTOR" {
			return "8"
		}
		return ""
	})
	if err == nil {
		t.Fatal("a prefetch factor above the cap holds leases while jobs wait and must be rejected")
	}
}

func TestConfigRejectsHeartbeatLongerThanLease(t *testing.T) {
	_, err := config.LoadFromEnv(func(key string) string {
		if key == "RHINOQ_LEASE_DURATION" {
			return "10s"
		}
		if key == "RHINOQ_HEARTBEAT_EVERY" {
			return "10s"
		}
		return ""
	})
	if err == nil {
		t.Fatal("expected invalid heartbeat configuration")
	}
}

// A reaper batch above the cap would put the engine back where it started: one
// statement whose lock time and WAL scale with the whole backlog.
func TestConfigRejectsAnUnboundedReapBatch(t *testing.T) {
	_, err := config.LoadFromEnv(func(key string) string {
		if key == "RHINOQ_REAP_BATCH_LIMIT" {
			return "5000"
		}
		return ""
	})
	if err == nil || !strings.Contains(err.Error(), "RHINOQ_REAP_BATCH_LIMIT") {
		t.Fatalf("an unbounded reap batch must be refused, got %v", err)
	}
}

// A sweep budget longer than the tick means the reaper never yields, so
// recovery and live claims compete for the same rows indefinitely.
func TestConfigRejectsASweepBudgetLongerThanItsTick(t *testing.T) {
	_, err := config.LoadFromEnv(func(key string) string {
		switch key {
		case "RHINOQ_REAPER_INTERVAL":
			return "10s"
		case "RHINOQ_REAP_SWEEP_BUDGET":
			return "30s"
		}
		return ""
	})
	if err == nil || !strings.Contains(err.Error(), "RHINOQ_REAP_SWEEP_BUDGET") {
		t.Fatalf("a sweep budget longer than the tick must be refused, got %v", err)
	}
}

func TestConfigDefaultsReapBoundsFromTheReaperInterval(t *testing.T) {
	loaded, err := config.LoadFromEnv(func(key string) string {
		if key == "RHINOQ_REAPER_INTERVAL" {
			return "20s"
		}
		return ""
	})
	if err != nil {
		t.Fatal(err)
	}
	if loaded.ReapBatchLimit != 500 {
		t.Fatalf("default reap batch must be 500, got %d", loaded.ReapBatchLimit)
	}
	if loaded.ReapSweepBudget != 10*time.Second {
		t.Fatalf("default sweep budget must be half the interval, got %s", loaded.ReapSweepBudget)
	}
}
