package health

import "context"

type Status string

const (
	Healthy   Status = "healthy"
	Unhealthy Status = "unhealthy"
)

type Check interface {
	Name() string
	Check(context.Context) error
}

type Result struct {
	Status Status
	Checks map[string]string
}

func Readiness(ctx context.Context, checks ...Check) Result {
	result := Result{Status: Healthy, Checks: make(map[string]string, len(checks))}
	for _, check := range checks {
		if check == nil {
			continue
		}
		if err := check.Check(ctx); err != nil {
			result.Status = Unhealthy
			result.Checks[check.Name()] = err.Error()
		} else {
			result.Checks[check.Name()] = "ok"
		}
	}
	return result
}
