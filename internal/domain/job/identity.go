package job

import (
	"errors"
	"strings"
)

// Identity separates the four meanings a single job name used to carry at once.
//
//	QueueName     execution lane: concurrency, rate limit, admission, pause
//	JobName       handler contract
//	GroupKey      tenant, customer or business partition
//	ResourceClass interactive, standard, batch, critical, maintenance
//
// Collapsing these into one string forced three bad trades. Two unrelated
// handlers could not share a worker pool without sharing a rate limit. One
// handler could not run in two lanes. A rate limit set for a lane silently
// became a limit on a handler contract.
//
// GroupKey is the only optional part. It carries no engine behaviour yet: it is
// stored and indexed so tenant-level fairness and sharding can be added without
// another identity migration.
type Identity struct {
	QueueName     string
	JobName       string
	GroupKey      string
	ResourceClass Class
}

var (
	ErrEmptyQueueName  = errors.New("queue name is required")
	ErrEmptyJobName    = errors.New("job name is required")
	ErrIdentityTooLong = errors.New(
		"queue name, job name and group key must each be at most 128 characters")
)

// MaxIdentityPartBytes bounds every identity part. The limit exists so an
// authenticated remote producer cannot inflate the hot table's row width, and
// so identity columns stay inside a btree index tuple.
const MaxIdentityPartBytes = 128

// Normalize trims each part, applies the default resource class and rejects an
// identity the engine cannot route. QueueName is deliberately not defaulted
// from JobName: making the lane implicit is exactly how a rate limit ends up
// attached to a handler contract by accident.
func (i Identity) Normalize() (Identity, error) {
	i.QueueName = strings.TrimSpace(i.QueueName)
	i.JobName = strings.TrimSpace(i.JobName)
	i.GroupKey = strings.TrimSpace(i.GroupKey)

	if i.QueueName == "" {
		return Identity{}, ErrEmptyQueueName
	}
	if i.JobName == "" {
		return Identity{}, ErrEmptyJobName
	}
	if len(i.QueueName) > MaxIdentityPartBytes ||
		len(i.JobName) > MaxIdentityPartBytes ||
		len(i.GroupKey) > MaxIdentityPartBytes {
		return Identity{}, ErrIdentityTooLong
	}

	class, err := NormalizeClass(i.ResourceClass)
	if err != nil {
		return Identity{}, err
	}
	i.ResourceClass = class
	return i, nil
}
