package unit

import (
	"testing"
	"time"

	"github.com/rhinoq/rhinoq/internal/infrastructure/config"
)

func TestConfigDefaultsAndValidation(t *testing.T) {
	c, err := config.LoadFromEnv(func(string) string { return "" })
	if err != nil {
		t.Fatal(err)
	}
	if c.ClaimLimit != 10 || c.Concurrency != 4 || c.HeartbeatEvery != 20*time.Second {
		t.Fatalf("unexpected defaults: %+v", c)
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
