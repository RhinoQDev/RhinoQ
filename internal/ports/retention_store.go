package ports

import (
	"context"
	"time"
)

// RetentionTarget names one table a prune can reclaim and how much of it is
// currently older than the cutoff.
type RetentionTarget struct {
	// Table is the physical table, because an operator sizing a maintenance
	// window needs to recognise it in pg_total_relation_size output.
	Table string
	// What describes the rows in the operator's terms rather than the schema's.
	What string
	Rows int64
}

// RetentionPlan is what a prune would remove. It is produced without deleting
// anything so the cost can be reviewed before it is paid.
type RetentionPlan struct {
	Cutoff  time.Time
	Targets []RetentionTarget
}

func (p RetentionPlan) Total() int64 {
	var total int64
	for _, target := range p.Targets {
		total += target.Rows
	}
	return total
}

// RetentionStore reclaims evidence that has outlived its usefulness.
//
// Every delete here is bounded. An unbounded DELETE against the table a running
// scan is writing to is how a retention job becomes the outage it was meant to
// prevent, so the store deletes in batches and reports what it removed.
type RetentionStore interface {
	PlanRetention(
		ctx context.Context,
		cutoff time.Time,
		ruleID string,
	) (RetentionPlan, error)
	// PruneRetention deletes at most batch rows per statement and stops when
	// the context is done, returning what it managed to remove. A partial
	// result is a normal outcome, not a failure: the next run resumes.
	PruneRetention(
		ctx context.Context,
		cutoff time.Time,
		ruleID string,
		batch int,
	) (RetentionPlan, error)
}
