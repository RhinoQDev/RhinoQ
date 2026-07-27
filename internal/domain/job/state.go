package job

import "fmt"

type State string

func (s State) String() string { return string(s) }

const (
	Pending   State = "pending"
	Leased    State = "leased"
	Succeeded State = "succeeded"
	RetryWait State = "retry_wait"
	Dead      State = "dead"
	Cancelled State = "cancelled"
	Blocked   State = "blocked"
)

func (s State) Valid() bool {
	switch s {
	case Pending, Leased, Succeeded, RetryWait, Dead, Cancelled, Blocked:
		return true
	default:
		return false
	}
}

func CanTransition(from, to State) bool {
	transitions := map[State]map[State]bool{
		Pending:   {Leased: true, Cancelled: true},
		Leased:    {Succeeded: true, RetryWait: true, Dead: true, Blocked: true, Cancelled: true},
		RetryWait: {Leased: true, Cancelled: true, Dead: true},
		Blocked:   {Leased: true, Cancelled: true},
		Succeeded: {}, Dead: {}, Cancelled: {},
	}
	return transitions[from][to]
}

func Transition(from, to State) (State, error) {
	if !CanTransition(from, to) {
		return from, fmt.Errorf("invalid job transition: %s -> %s", from, to)
	}
	return to, nil
}
