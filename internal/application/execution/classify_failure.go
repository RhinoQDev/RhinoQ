package execution

import (
	"time"

	"github.com/rhinoq/rhinoq/internal/domain/retry"
)

type FailureClassifier struct {
	Policy retry.Policy
}

func (f FailureClassifier) Decide(class retry.Class, attempt int, now time.Time, retryAfter time.Duration) retry.Decision {
	return f.Policy.Decide(class, attempt, now, retryAfter)
}
