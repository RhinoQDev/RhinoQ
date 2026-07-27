package worker

import (
	"context"
	"time"
)

// ShutdownReport says what a stop actually did. Abandoned is the number that
// matters on a deploy: those handlers were still running when the worker gave
// up waiting, and their leases were deliberately left to expire.
type ShutdownReport struct {
	Running   int
	Drained   int
	Cancelled int
	Abandoned int
}

// Shutdown performs the six-step stop from specification 9.1:
//
//  1. stop claiming new jobs
//  2. wait for running handlers within the grace period
//  3. signal cancellation to whatever is left
//  4. wait for handlers to react
//  5. in-process handlers cannot be terminated, so nothing further is forced
//  6. leases are never released while a handler may still be running
//
// Step 6 is the reason a timed-out handler leaves its lease alone: releasing it
// early is what produces two live executions of the same job, which is worse
// than the slower recovery of waiting for the lease to expire.
func (w *Worker) Shutdown(ctx context.Context) ShutdownReport {
	w.shutdownMu.Lock()
	defer w.shutdownMu.Unlock()

	w.claiming.Store(false)
	report := ShutdownReport{Running: w.Running()}
	if report.Running == 0 {
		return report
	}

	if w.awaitDrain(ctx, w.shutdownGrace) {
		report.Drained = report.Running
		return report
	}

	remaining := w.Running()
	report.Drained = report.Running - remaining
	report.Cancelled = w.runningCount()
	w.cancelRunning()

	if w.awaitDrain(ctx, w.cancelGrace) {
		return report
	}
	report.Abandoned = w.Running()
	return report
}

// StopClaiming stops the worker taking new work while leaving running handlers
// alone. It is the first shutdown step, exposed for readiness draining.
func (w *Worker) StopClaiming() { w.claiming.Store(false) }

// Running reports how much claimed work this worker still holds: handlers that
// are executing plus prefetched jobs waiting for a slot.
func (w *Worker) Running() int { return int(w.inflight.Load()) }

func (w *Worker) runningCount() int {
	w.mu.Lock()
	defer w.mu.Unlock()
	return len(w.running)
}

func (w *Worker) cancelRunning() {
	w.mu.Lock()
	cancels := make([]context.CancelFunc, 0, len(w.running))
	for _, cancel := range w.running {
		cancels = append(cancels, cancel)
	}
	w.mu.Unlock()
	for _, cancel := range cancels {
		cancel()
	}
}

func (w *Worker) awaitDrain(ctx context.Context, within time.Duration) bool {
	if within <= 0 {
		return w.Running() == 0
	}
	deadline := time.NewTimer(within)
	defer deadline.Stop()
	poll := time.NewTicker(pollDrainEvery)
	defer poll.Stop()
	for {
		if w.Running() == 0 {
			return true
		}
		select {
		case <-ctx.Done():
			return w.Running() == 0
		case <-deadline.C:
			return w.Running() == 0
		case <-poll.C:
		}
	}
}

const pollDrainEvery = 2 * time.Millisecond
