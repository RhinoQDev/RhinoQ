package tasks

import (
	"context"
	"errors"
	"time"

	taskcontract "github.com/madebyduy/RhinoQ/internal/contracts/task"
	"github.com/madebyduy/RhinoQ/internal/domain/correlation"
	"github.com/madebyduy/RhinoQ/internal/domain/execution"
	"github.com/madebyduy/RhinoQ/internal/domain/task"
	"github.com/madebyduy/RhinoQ/internal/ports"
)

type Service struct {
	tasks      ports.TaskStore
	executions ports.ExecutionStore
	now        func() time.Time
}

func New(taskStore ports.TaskStore, executionStore ports.ExecutionStore, now func() time.Time) (*Service, error) {
	if taskStore == nil || executionStore == nil {
		return nil, errors.New("task and execution stores are required")
	}
	if now == nil {
		now = func() time.Time { return time.Now().UTC() }
	}
	return &Service{tasks: taskStore, executions: executionStore, now: now}, nil
}

type CreateInput struct {
	ID                task.ID
	Type              string
	OwnerID           string
	DefinitionVersion int
}

func (s *Service) Create(ctx context.Context, input CreateInput) (task.Record, error) {
	record, err := task.NewRecord(task.Spec{
		ID: input.ID, Type: input.Type, OwnerID: input.OwnerID,
		DefinitionVersion: input.DefinitionVersion, Now: s.now(),
	})
	if err != nil {
		return task.Record{}, err
	}
	return s.tasks.CreateTask(ctx, record)
}

// CreateSnapshot answers the create command without re-reading: a Task that has
// just been accepted by the store cannot have executions yet.
func (s *Service) CreateSnapshot(ctx context.Context, input CreateInput) (taskcontract.Snapshot, error) {
	record, err := s.Create(ctx, input)
	if err != nil {
		return taskcontract.Snapshot{}, err
	}
	return newSnapshot(record, nil)
}

type CreateExecutionInput struct {
	ID      execution.ID
	TaskID  task.ID
	Runtime string
	// Trace is the caller's W3C trace context. It is threaded explicitly rather
	// than carried in the request context because it is persisted: a field on
	// the input can be asserted in a store test without constructing a request,
	// and the domain layer stays free of context, which is a rule this codebase
	// keeps deliberately.
	Trace correlation.TraceContext
}

type RetryInput struct {
	CommandID       string
	TaskID          task.ID
	ExpectedVersion int64
	ExecutionID     execution.ID
	Runtime         string
	Queue           string
	JobName         string
	Payload         []byte
	Trace           correlation.TraceContext
}

// Retry crosses a transactional store boundary so a crash can never leave a
// queued Task without a durable dispatch intent. Correctness stays in the Go
// application/domain and store, not in a producer SDK callback.
func (s *Service) Retry(ctx context.Context, input RetryInput) (taskcontract.Snapshot, error) {
	store, ok := s.tasks.(ports.TaskRetryStore)
	if !ok {
		return taskcontract.Snapshot{}, errors.New("task store does not support durable retry")
	}
	result, err := store.RetryTask(ctx, ports.TaskRetryInput{
		CommandID: input.CommandID, TaskID: input.TaskID,
		ExpectedVersion: input.ExpectedVersion, ExecutionID: input.ExecutionID,
		Runtime: input.Runtime, Queue: input.Queue, JobName: input.JobName,
		Payload: input.Payload, Trace: input.Trace, Now: s.now(),
	})
	if err != nil {
		return taskcontract.Snapshot{}, err
	}
	return s.snapshot(ctx, result.Task)
}

func (s *Service) CreateExecution(ctx context.Context, input CreateExecutionInput) (execution.Record, error) {
	if _, found, err := s.tasks.GetTask(ctx, input.TaskID); err != nil {
		return execution.Record{}, err
	} else if !found {
		return execution.Record{}, ports.ErrTaskNotFound
	}
	record, _, err := s.executions.CreateNextExecution(ctx, ports.ExecutionCreateInput{
		ID: input.ID, TaskID: input.TaskID.String(), Runtime: input.Runtime,
		Trace: input.Trace, Now: s.now(),
	})
	return record, err
}

func (s *Service) BindExecution(ctx context.Context, id execution.ID, reference execution.RuntimeReference) (execution.Record, error) {
	record, found, err := s.executions.GetExecution(ctx, id)
	if err != nil {
		return execution.Record{}, err
	}
	if !found {
		return execution.Record{}, ports.ErrExecutionNotFound
	}
	expectedVersion := record.Version
	record, err = record.Bind(reference, s.now())
	if err != nil {
		return execution.Record{}, err
	}
	record, _, err = s.executions.UpdateExecution(ctx, record, expectedVersion)
	return record, err
}

func (s *Service) Get(ctx context.Context, id task.ID) (taskcontract.Snapshot, error) {
	record, found, err := s.tasks.GetTask(ctx, id)
	if err != nil {
		return taskcontract.Snapshot{}, err
	}
	if !found {
		return taskcontract.Snapshot{}, ports.ErrTaskNotFound
	}
	return s.snapshot(ctx, record)
}

func (s *Service) GetSummary(ctx context.Context, id task.ID) (taskcontract.Summary, error) {
	record, found, err := s.tasks.GetTask(ctx, id)
	if err != nil {
		return taskcontract.Summary{}, err
	}
	if !found {
		return taskcontract.Summary{}, ports.ErrTaskNotFound
	}
	return newSummary(record)
}

func (s *Service) ListExecutionsPage(
	ctx context.Context, id task.ID, cursor string, limit int,
) (taskcontract.ExecutionPage, error) {
	if limit <= 0 || limit > maxExecutionPageSize {
		return taskcontract.ExecutionPage{}, errors.New("execution page limit must be between 1 and 500")
	}
	record, found, err := s.tasks.GetTask(ctx, id)
	if err != nil {
		return taskcontract.ExecutionPage{}, err
	}
	if !found {
		return taskcontract.ExecutionPage{}, ports.ErrTaskNotFound
	}
	after, err := decodeExecutionCursor(cursor)
	if err != nil {
		return taskcontract.ExecutionPage{}, err
	}
	if after.ID != "" {
		cursorRecord, found, getErr := s.executions.GetExecution(ctx, execution.ID(after.ID))
		if getErr != nil {
			return taskcontract.ExecutionPage{}, getErr
		}
		if !found || cursorRecord.TaskID != id.String() {
			return taskcontract.ExecutionPage{}, errors.New("invalid execution cursor")
		}
	}
	attempts, more, err := s.executions.ListTaskExecutionsPage(ctx, ports.ExecutionPageQuery{
		TaskID: id.String(), AfterID: after.ID, Limit: limit,
	})
	if err != nil {
		return taskcontract.ExecutionPage{}, err
	}
	items := make([]taskcontract.Execution, 0, len(attempts))
	for _, attempt := range attempts {
		item, err := executionContract(attempt)
		if err != nil || attempt.TaskID != id.String() {
			if err == nil {
				err = taskcontract.ErrInvalidSnapshot
			}
			return taskcontract.ExecutionPage{}, err
		}
		items = append(items, item)
	}
	page := taskcontract.ExecutionPage{
		SchemaVersion: taskcontract.ExecutionPageSchemaVersion,
		EntityVersion: record.Version, TaskID: id.String(), Executions: items,
	}
	if more && len(attempts) > 0 {
		page.NextCursor = encodeExecutionCursor(attempts[len(attempts)-1])
	}
	return page, page.Validate()
}

// snapshot renders a record the caller already holds. Commands use it instead
// of re-reading the Task: the store returns the row it just fenced, so another
// read only costs a round trip and risks answering a command with a version
// that some concurrent writer produced instead.
func (s *Service) snapshot(ctx context.Context, record task.Record) (taskcontract.Snapshot, error) {
	executions, err := s.executions.ListTaskExecutions(ctx, record.ID.String())
	if err != nil {
		return taskcontract.Snapshot{}, err
	}
	return newSnapshot(record, executions)
}

func (s *Service) Transition(ctx context.Context, id task.ID, expectedVersion int64, to task.State) (taskcontract.Snapshot, error) {
	record, found, err := s.tasks.GetTask(ctx, id)
	if err != nil {
		return taskcontract.Snapshot{}, err
	}
	if !found {
		return taskcontract.Snapshot{}, ports.ErrTaskNotFound
	}
	if record.Version != expectedVersion {
		return taskcontract.Snapshot{}, ports.ErrVersionConflict
	}
	next, err := record.Transition(to, s.now())
	if err != nil {
		return taskcontract.Snapshot{}, err
	}
	saved, err := s.tasks.UpdateTask(ctx, next, expectedVersion)
	if err != nil {
		return taskcontract.Snapshot{}, err
	}
	return s.snapshot(ctx, saved)
}

// RequestCancellation is the end-user cancel command. Unlike the operator
// lifecycle commands it tolerates a repeat: the second request cannot lose an
// update, so it is answered from the stored record rather than fenced against a
// version the caller may no longer hold.
func (s *Service) RequestCancellation(
	ctx context.Context,
	id task.ID,
	expectedVersion int64,
) (taskcontract.Snapshot, error) {
	record, found, err := s.tasks.GetTask(ctx, id)
	if err != nil {
		return taskcontract.Snapshot{}, err
	}
	if !found {
		return taskcontract.Snapshot{}, ports.ErrTaskNotFound
	}
	if record.CancellationIsRequested() {
		return s.snapshot(ctx, record)
	}
	if record.Version != expectedVersion {
		return taskcontract.Snapshot{}, ports.ErrVersionConflict
	}
	next, err := record.RequestCancellation(s.now())
	if err != nil {
		return taskcontract.Snapshot{}, err
	}
	saved, err := s.tasks.UpdateTask(ctx, next, expectedVersion)
	if err != nil {
		return taskcontract.Snapshot{}, err
	}
	return s.snapshot(ctx, saved)
}

func (s *Service) UpdateProgress(ctx context.Context, id task.ID, expectedVersion int64, progress task.Progress) (taskcontract.Snapshot, error) {
	record, found, err := s.tasks.GetTask(ctx, id)
	if err != nil {
		return taskcontract.Snapshot{}, err
	}
	if !found {
		return taskcontract.Snapshot{}, ports.ErrTaskNotFound
	}
	// Fan-out runtimes re-deliver progress events, so an identical write is the
	// normal case rather than an edge case. It stores nothing, so it consumes no
	// version and needs no fence: failing it would turn a duplicate into a
	// conflict for the writer that is genuinely up to date.
	if record.ProgressIsCurrent(progress) {
		return s.snapshot(ctx, record)
	}
	if record.Version != expectedVersion {
		return taskcontract.Snapshot{}, ports.ErrVersionConflict
	}
	next, err := record.ApplyProgress(progress, s.now())
	if err != nil {
		return taskcontract.Snapshot{}, err
	}
	saved, err := s.tasks.UpdateTask(ctx, next, expectedVersion)
	if err != nil {
		return taskcontract.Snapshot{}, err
	}
	return s.snapshot(ctx, saved)
}

func (s *Service) ResolveCancellation(
	ctx context.Context,
	id task.ID,
	expectedVersion int64,
	status task.CancellationStatus,
	reason string,
) (taskcontract.Snapshot, error) {
	record, found, err := s.tasks.GetTask(ctx, id)
	if err != nil {
		return taskcontract.Snapshot{}, err
	}
	if !found {
		return taskcontract.Snapshot{}, ports.ErrTaskNotFound
	}
	if record.Version != expectedVersion {
		return taskcontract.Snapshot{}, ports.ErrVersionConflict
	}
	next, err := record.ResolveCancellation(status, reason, s.now())
	if err != nil {
		return taskcontract.Snapshot{}, err
	}
	saved, err := s.tasks.UpdateTask(ctx, next, expectedVersion)
	if err != nil {
		return taskcontract.Snapshot{}, err
	}
	return s.snapshot(ctx, saved)
}
