package unit

import (
	"context"
	"errors"
	"testing"

	"github.com/rhinoq/rhinoq/internal/infrastructure/health"
)

type healthCheck struct {
	name string
	err  error
}

func (c healthCheck) Name() string                { return c.name }
func (c healthCheck) Check(context.Context) error { return c.err }

func TestReadinessAggregatesChecks(t *testing.T) {
	result := health.Readiness(context.Background(), healthCheck{name: "postgres"}, healthCheck{name: "redis", err: errors.New("down")})
	if result.Status != health.Unhealthy || result.Checks["postgres"] != "ok" || result.Checks["redis"] != "down" {
		t.Fatalf("unexpected readiness result: %+v", result)
	}
}
