package job

import (
	"errors"
	"time"
)

// Class is the resource class of a job. It decides which share of a queue's
// admission budget the job may use and, later, which work is shed first when the
// database is under pressure.
type Class string

const (
	Critical    Class = "critical"
	Interactive Class = "interactive"
	Standard    Class = "standard"
	Batch       Class = "batch"
	Maintenance Class = "maintenance"
)

var ErrInvalidClass = errors.New("job class must be critical, interactive, standard, batch or maintenance")

// NormalizeClass returns the effective class for a job. An empty class means the
// caller did not choose one, which resolves to Standard.
func NormalizeClass(class Class) (Class, error) {
	switch class {
	case "":
		return Standard, nil
	case Critical, Interactive, Standard, Batch, Maintenance:
		return class, nil
	default:
		return "", ErrInvalidClass
	}
}

func (c Class) IsCritical() bool { return c == Critical }

// Scheduling is design A of the specification: priority first, FIFO inside a
// priority, and priority aging so that low priority work cannot starve forever.
// It is deliberately not weighted deficit round robin - the SQL and this code
// must describe the same algorithm.
const (
	// AgingBoostPerHour is how much effective priority a waiting job gains for
	// every hour it stays eligible but unclaimed.
	AgingBoostPerHour = 1.0
	// MaxAgingBoost caps the boost so that aged batch work can never overtake
	// fresh critical work indefinitely.
	MaxAgingBoost = 5.0
)

// EffectivePriority is the ordering key used by every claim implementation. The
// PostgreSQL adapter reproduces this exact formula in SQL; keep them in sync.
func EffectivePriority(priority int, notBefore, now time.Time) float64 {
	waited := now.Sub(notBefore)
	if waited <= 0 {
		return float64(priority)
	}
	boost := waited.Hours() * AgingBoostPerHour
	if boost > MaxAgingBoost {
		boost = MaxAgingBoost
	}
	return float64(priority) + boost
}

// Protection bounds how often a single job may take a worker down with it. A job
// that repeatedly kills its worker never records a normal failed attempt, so
// MaxAttempts alone cannot stop it (specification 9.4).
type Protection struct {
	MaxWorkerCrashesPerJob int
}

const DefaultMaxWorkerCrashesPerJob = 3

func (p Protection) Normalize() Protection {
	if p.MaxWorkerCrashesPerJob <= 0 {
		p.MaxWorkerCrashesPerJob = DefaultMaxWorkerCrashesPerJob
	}
	return p
}

// IsPoisoned reports whether a job that just lost its lease has crashed enough
// workers to be parked instead of handed to the next one. crashCount is the
// count including the crash being recorded.
func (p Protection) IsPoisoned(crashCount int) bool {
	return crashCount >= p.Normalize().MaxWorkerCrashesPerJob
}
