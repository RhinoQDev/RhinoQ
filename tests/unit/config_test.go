package unit

import (
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
