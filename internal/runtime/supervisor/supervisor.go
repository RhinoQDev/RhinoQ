package supervisor

import (
	"context"
	"errors"
	"sync"
)

type Runner interface {
	Run(context.Context) error
}

type Supervisor struct {
	runners []Runner
}

func New(runners ...Runner) (*Supervisor, error) {
	if len(runners) == 0 {
		return nil, errors.New("at least one runtime runner is required")
	}
	for _, runner := range runners {
		if runner == nil {
			return nil, errors.New("runtime runner cannot be nil")
		}
	}
	return &Supervisor{runners: runners}, nil
}

func (s *Supervisor) Run(parent context.Context) error {
	if parent == nil {
		return errors.New("supervisor context is required")
	}
	ctx, cancel := context.WithCancel(parent)
	defer cancel()

	errs := make(chan error, len(s.runners))
	var wg sync.WaitGroup
	for _, runner := range s.runners {
		wg.Add(1)
		go func(runner Runner) {
			defer wg.Done()
			if err := runner.Run(ctx); err != nil && !errors.Is(err, context.Canceled) {
				errs <- err
				cancel()
			}
		}(runner)
	}

	done := make(chan struct{})
	go func() { wg.Wait(); close(done) }()
	select {
	case <-parent.Done():
		cancel()
		<-done
		return parent.Err()
	case err := <-errs:
		cancel()
		<-done
		return err
	case <-done:
		select {
		case err := <-errs:
			return err
		default:
			return nil
		}
	}
}
