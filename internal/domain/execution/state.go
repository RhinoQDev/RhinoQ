package execution

import "fmt"

// State tracks one attempt to execute a Task. Retrying a Task creates a new
// Execution instead of moving a terminal Execution back to a running state.
type State string

const (
	PendingDispatch State = "pending_dispatch"
	Dispatched      State = "dispatched"
	Running         State = "running"
	Succeeded       State = "succeeded"
	Failed          State = "failed"
	Stalled         State = "stalled"
	Cancelled       State = "cancelled"
)

func (s State) String() string { return string(s) }

func (s State) Valid() bool {
	switch s {
	case PendingDispatch, Dispatched, Running, Succeeded, Failed, Stalled, Cancelled:
		return true
	default:
		return false
	}
}

func CanTransition(from, to State) bool {
	transitions := map[State]map[State]bool{
		PendingDispatch: {Dispatched: true, Cancelled: true},
		Dispatched:      {Running: true, Failed: true, Stalled: true, Cancelled: true},
		Running:         {Succeeded: true, Failed: true, Stalled: true, Cancelled: true},
		Stalled:         {Dispatched: true, Failed: true, Cancelled: true},
		Succeeded:       {},
		Failed:          {},
		Cancelled:       {},
	}
	return transitions[from][to]
}

func Transition(from, to State) (State, error) {
	if !from.Valid() || !to.Valid() || !CanTransition(from, to) {
		return from, fmt.Errorf("invalid execution transition: %s -> %s", from, to)
	}
	return to, nil
}
