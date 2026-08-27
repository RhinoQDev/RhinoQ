package ports

import "time"

// ExecutionObserver receives the one measurement only the runtime can take
// honestly: how long a handler ran.
//
// It is a port rather than a direct dependency because the layer rules forbid
// the runtime from importing infrastructure, and that rule is right here rather
// than inconvenient. A worker that imported a metrics implementation would be a
// worker that cannot be built without one, and the scheduling loop has no
// business knowing whether the numbers it produces end up in Prometheus, in a
// test assertion, or nowhere.
//
// The interface is one method because that is the whole need. Widening it to
// "the metrics interface" would invite the runtime to report things it cannot
// measure without a second clock.
type ExecutionObserver interface {
	// ObserveExecution records one handler run. Implementations must tolerate
	// being called from many goroutines and must not block: it is called on the
	// path between a handler returning and its terminal write.
	ObserveExecution(queue string, elapsed time.Duration)
}
