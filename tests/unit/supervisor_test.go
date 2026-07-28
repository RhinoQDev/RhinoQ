package unit

import (
	"context"
	"errors"
	"testing"

	"github.com/madebyduy/RhinoQ/internal/runtime/supervisor"
)

type runnerFunc func(context.Context) error

func (f runnerFunc) Run(ctx context.Context) error { return f(ctx) }

func TestSupervisorStopsAllRunnersOnFailure(t *testing.T) {
	expected := errors.New("runner failed")
	s, err := supervisor.New(
		runnerFunc(func(context.Context) error { return expected }),
		runnerFunc(func(ctx context.Context) error { <-ctx.Done(); return ctx.Err() }),
	)
	if err != nil {
		t.Fatal(err)
	}
	if err := s.Run(context.Background()); !errors.Is(err, expected) {
		t.Fatalf("expected runner error, got %v", err)
	}
}
