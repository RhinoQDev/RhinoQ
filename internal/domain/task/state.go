package task

import "fmt"

// State is the user-facing lifecycle of a Task. Execution, effect and outcome
// states are intentionally modeled in their own domains.
type State string

const (
	Pending         State = "pending"
	Queued          State = "queued"
	Running         State = "running"
	Uncertain       State = "uncertain"
	Succeeded       State = "succeeded"
	Failed          State = "failed"
	CancelRequested State = "cancel_requested"
	Cancelled       State = "cancelled"
)

func (s State) String() string { return string(s) }

func (s State) Valid() bool {
	switch s {
	case Pending, Queued, Running, Uncertain, Succeeded, Failed, CancelRequested, Cancelled:
		return true
	default:
		return false
	}
}

// CanTransition describes lifecycle transitions only. Retry and cancellation
// command semantics will add actor, commandId and expected-version checks in
// the application layer; they do not belong in this pure state table.
func CanTransition(from, to State) bool {
	transitions := map[State]map[State]bool{
		Pending:         {Queued: true, Cancelled: true},
		Queued:          {Running: true, CancelRequested: true, Cancelled: true},
		Running:         {Uncertain: true, Succeeded: true, Failed: true, CancelRequested: true},
		Uncertain:       {Succeeded: true, Failed: true},
		CancelRequested: {Uncertain: true, Succeeded: true, Failed: true, Cancelled: true},
		Failed:          {Queued: true},
		Succeeded:       {},
		Cancelled:       {Queued: true},
	}
	return transitions[from][to]
}

func Transition(from, to State) (State, error) {
	if !from.Valid() || !to.Valid() || !CanTransition(from, to) {
		return from, fmt.Errorf("invalid task transition: %s -> %s", from, to)
	}
	return to, nil
}
