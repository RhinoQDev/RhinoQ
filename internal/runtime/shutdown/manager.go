package shutdown

import (
	"context"
	"os"
	"os/signal"
	"syscall"
)

func Context(parent context.Context) (context.Context, context.CancelFunc) {
	return signal.NotifyContext(parent, os.Interrupt, syscall.SIGTERM)
}
