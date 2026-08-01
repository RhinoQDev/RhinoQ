package ports

import (
	"context"
	"time"

	"github.com/madebyduy/RhinoQ/internal/domain/execution"
	"github.com/madebyduy/RhinoQ/internal/domain/task"
)

// TaskStore persists the user-facing aggregate with optimistic version checks.
// expectedVersion is the version read before applying the domain mutation.
type TaskStore interface {
	CreateTask(ctx context.Context, record task.Record) (task.Record, error)
	GetTask(ctx context.Context, id task.ID) (task.Record, bool, error)
	UpdateTask(ctx context.Context, record task.Record, expectedVersion int64) (task.Record, error)
}

// ExecutionStore persists attempts separately from Task so an external runtime
// cannot overwrite user-facing state without an application use case.
type ExecutionStore interface {
	// CreateNextExecution allocates the next attempt atomically. A read-then-write
	// attempt number in Application would race when two retry commands arrive.
	// CreateNextExecution mutates the Task aggregate as well as its child
	// Execution. taskVersion is the new Snapshot/entity version.
	CreateNextExecution(ctx context.Context, input ExecutionCreateInput) (record execution.Record, taskVersion int64, err error)
	GetExecution(ctx context.Context, id execution.ID) (execution.Record, bool, error)
	// FindExecutionByExternalReference is the restart-safe lookup path for a
	// runtime adapter. The unique (runtime, external_id) constraint means an
	// adapter can recover a Task execution from its own job ID after a process
	// restart without keeping an in-memory map as the source of truth.
	FindExecutionByExternalReference(ctx context.Context, runtime, externalID string) (execution.Record, bool, error)
	// UpdateExecution also advances the parent Task version atomically so two
	// snapshots with the same entityVersion cannot contain different execution
	// state.
	UpdateExecution(ctx context.Context, record execution.Record, expectedVersion int64) (updated execution.Record, taskVersion int64, err error)
	ListTaskExecutions(ctx context.Context, taskID string) ([]execution.Record, error)
	ListTaskExecutionsPage(ctx context.Context, query ExecutionPageQuery) ([]execution.Record, bool, error)
}

type ExecutionCreateInput struct {
	ID      execution.ID
	TaskID  string
	Runtime string
	Now     time.Time
}

// ExecutionPageQuery is a stable keyset page. CreatedAt and ID form a total
// order, so inserts cannot shift rows between pages as offset pagination does.
type ExecutionPageQuery struct {
	TaskID  string
	AfterID string
	Limit   int
}
