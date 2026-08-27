package rhinoq

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	taskapp "github.com/madebyduy/RhinoQ/internal/application/tasks"
	taskcontract "github.com/madebyduy/RhinoQ/internal/contracts/task"
	"github.com/madebyduy/RhinoQ/internal/domain/correlation"
	"github.com/madebyduy/RhinoQ/internal/domain/execution"
	domaintask "github.com/madebyduy/RhinoQ/internal/domain/task"
	"github.com/madebyduy/RhinoQ/internal/domain/waitpoint"
	"github.com/madebyduy/RhinoQ/internal/ports"
)

var (
	ErrTaskNotFound              = ports.ErrTaskNotFound
	ErrTaskResultNotFound        = ports.ErrTaskResultNotFound
	ErrTaskVersionConflict       = ports.ErrVersionConflict
	ErrTaskAlreadyExists         = ports.ErrAlreadyExists
	ErrExecutionAlreadyBound     = execution.ErrAlreadyBound
	ErrExecutionInvalidReference = execution.ErrInvalidReference
	ErrWaitpointNotFound         = ports.ErrWaitpointNotFound
	ErrWaitpointConflict         = ports.ErrWaitpointConflict
)

type TaskWaitpoint struct {
	SchemaVersion  int             `json:"schemaVersion"`
	EntityVersion  int64           `json:"entityVersion"`
	ID             string          `json:"id"`
	TaskID         string          `json:"taskId"`
	Key            string          `json:"key"`
	Kind           string          `json:"kind"`
	State          string          `json:"state"`
	PayloadVersion int             `json:"payloadVersion"`
	Deadline       *time.Time      `json:"deadline,omitempty"`
	Resolution     json.RawMessage `json:"resolution,omitempty"`
	ResolvedBy     string          `json:"resolvedBy,omitempty"`
	ResolvedAt     *time.Time      `json:"resolvedAt,omitempty"`
	CreatedAt      time.Time       `json:"createdAt"`
	UpdatedAt      time.Time       `json:"updatedAt"`
}

type TaskWaitpointCreateRequest struct {
	ID, Key        string
	Kind           string
	PayloadVersion int
	Deadline       time.Time
}

type TaskWaitpointResolveRequest struct {
	OwnerID, ResolutionID, Actor string
	ExpectedVersion              int64
	Resolution                   json.RawMessage
}

func (c *Client) CreateTaskWaitpoint(ctx context.Context, taskID string, request TaskWaitpointCreateRequest) (TaskWaitpoint, bool, error) {
	service, err := c.taskService()
	if err != nil {
		return TaskWaitpoint{}, false, err
	}
	record, replayed, err := service.CreateWaitpoint(ctx, taskapp.CreateWaitpointInput{ID: request.ID, TaskID: taskID, Key: request.Key, Kind: waitpoint.Kind(request.Kind), SchemaVersion: request.PayloadVersion, Deadline: request.Deadline})
	return publicTaskWaitpoint(record), replayed, err
}

func (c *Client) GetTaskWaitpoint(ctx context.Context, id, ownerID string) (TaskWaitpoint, error) {
	service, err := c.taskService()
	if err != nil {
		return TaskWaitpoint{}, err
	}
	record, err := service.GetWaitpoint(ctx, waitpoint.ID(id), ownerID)
	return publicTaskWaitpoint(record), err
}

func (c *Client) ResolveTaskWaitpoint(ctx context.Context, id string, request TaskWaitpointResolveRequest) (TaskWaitpoint, error) {
	service, err := c.taskService()
	if err != nil {
		return TaskWaitpoint{}, err
	}
	record, err := service.ResolveWaitpoint(ctx, taskapp.ResolveWaitpointInput{ID: id, OwnerID: request.OwnerID, ResolutionID: request.ResolutionID, Actor: request.Actor, ExpectedVersion: request.ExpectedVersion, Resolution: request.Resolution})
	return publicTaskWaitpoint(record), err
}

func (c *Client) ExpireDueTaskWaitpoints(ctx context.Context, limit int) (int, error) {
	service, err := c.taskService()
	if err != nil {
		return 0, err
	}
	return service.ExpireDueWaitpoints(ctx, limit)
}

func publicTaskWaitpoint(record waitpoint.Record) TaskWaitpoint {
	result := TaskWaitpoint{SchemaVersion: 1, EntityVersion: record.Version, ID: record.ID.String(), TaskID: record.TaskID, Key: record.Key, Kind: string(record.Kind), State: string(record.State), PayloadVersion: record.SchemaVersion, Resolution: append(json.RawMessage(nil), record.Resolution...), ResolvedBy: record.ResolvedBy, CreatedAt: record.CreatedAt, UpdatedAt: record.UpdatedAt}
	if !record.Deadline.IsZero() {
		deadline := record.Deadline
		result.Deadline = &deadline
	}
	if !record.ResolvedAt.IsZero() {
		resolvedAt := record.ResolvedAt
		result.ResolvedAt = &resolvedAt
	}
	return result
}

type TaskState string

const (
	TaskPending         TaskState = "pending"
	TaskQueued          TaskState = "queued"
	TaskRunning         TaskState = "running"
	TaskUncertain       TaskState = "uncertain"
	TaskSucceeded       TaskState = "succeeded"
	TaskFailed          TaskState = "failed"
	TaskCancelRequested TaskState = "cancel_requested"
	TaskCancelled       TaskState = "cancelled"
)

type TaskCreateRequest struct {
	ID                string `json:"id"`
	Type              string `json:"type"`
	OwnerID           string `json:"ownerId,omitempty"`
	DefinitionVersion int    `json:"definitionVersion"`
}

type TaskProgress struct {
	Completed int64  `json:"completed"`
	Total     *int64 `json:"total,omitempty"`
	Message   string `json:"message,omitempty"`
}

type TaskExecutionSummary struct {
	ID            string `json:"id"`
	Attempt       int    `json:"attempt"`
	Runtime       string `json:"runtime"`
	State         string `json:"state"`
	Version       int64  `json:"version"`
	HasResult     bool   `json:"hasResult"`
	FailureReason string `json:"failureReason,omitempty"`
	// TraceID is the join key into the adopter's tracing system, empty when the
	// attempt was created without an inbound trace.
	TraceID string `json:"traceId,omitempty"`
}

// TaskExecutionResult is one item's outcome in a fan-out. The reference is
// deliberately absent from TaskSnapshot and read here instead.
type TaskExecutionResult struct {
	ExecutionID   string    `json:"executionId"`
	Attempt       int       `json:"attempt"`
	State         string    `json:"state"`
	Reference     string    `json:"reference,omitempty"`
	FailureReason string    `json:"failureReason,omitempty"`
	UpdatedAt     time.Time `json:"updatedAt"`
}

type TaskExecutionResults struct {
	SchemaVersion int                   `json:"schemaVersion"`
	EntityVersion int64                 `json:"entityVersion"`
	TaskID        string                `json:"taskId"`
	Executions    []TaskExecutionResult `json:"executions"`
}

type TaskCancellation struct {
	Status string `json:"status"`
	Reason string `json:"reason,omitempty"`
}

// TaskExecution is the adapter-facing view of one attempt. It intentionally
// exposes no owner or runtime reference: an adapter already holds the external
// ID it used for the lookup and only needs the Task relationship plus a version
// fence for the next observation.
type TaskExecution struct {
	ID      string `json:"id"`
	TaskID  string `json:"taskId"`
	Runtime string `json:"runtime"`
	State   string `json:"state"`
	Version int64  `json:"version"`
}

type TaskExecutionCreateRequest struct {
	ID      string `json:"id"`
	Runtime string `json:"runtime"`
	// TraceParent and TraceState carry W3C trace context for this attempt.
	//
	// They are fields on the request rather than headers-only because an
	// embedder that calls this Client in-process has no HTTP request to put a
	// header on, and the correlation is worth the same to them. The Agent's HTTP
	// boundary fills them from the incoming headers when the body leaves them
	// empty, so an ordinary HTTP caller propagates a trace without changing its
	// payload.
	//
	// A value that is not a valid traceparent is dropped, not rejected.
	TraceParent string `json:"traceparent,omitempty"`
	TraceState  string `json:"tracestate,omitempty"`
}

// TaskExecutionBinding carries the durable runtime identity on write. Snapshot
// responses intentionally omit JobID and ExternalID.
type TaskExecutionBinding struct {
	Runtime    string `json:"runtime"`
	JobID      string `json:"jobId,omitempty"`
	ExternalID string `json:"externalId,omitempty"`
}

type TaskResult struct {
	SchemaVersion int       `json:"schemaVersion"`
	EntityVersion int64     `json:"entityVersion"`
	TaskID        string    `json:"taskId"`
	Reference     string    `json:"reference"`
	UpdatedAt     time.Time `json:"updatedAt"`
}

// TaskSnapshot is the polling contract. EntityVersion is monotonic for one
// Task and lets clients ignore a stale response delivered after a newer one.
type TaskSnapshot struct {
	SchemaVersion int                    `json:"schemaVersion"`
	EntityVersion int64                  `json:"entityVersion"`
	ID            string                 `json:"id"`
	Type          string                 `json:"type"`
	OwnerID       string                 `json:"ownerId,omitempty"`
	State         TaskState              `json:"state"`
	Cancellation  TaskCancellation       `json:"cancellation"`
	Progress      TaskProgress           `json:"progress"`
	HasResult     bool                   `json:"hasResult"`
	Executions    []TaskExecutionSummary `json:"executions"`
	CreatedAt     time.Time              `json:"createdAt"`
	UpdatedAt     time.Time              `json:"updatedAt"`
}

// TaskSummary is the lightweight polling contract. It advances with the same
// EntityVersion as TaskSnapshot but never embeds the growing execution list.
type TaskSummary struct {
	SchemaVersion   int                 `json:"schemaVersion"`
	EntityVersion   int64               `json:"entityVersion"`
	ID              string              `json:"id"`
	Type            string              `json:"type"`
	OwnerID         string              `json:"ownerId,omitempty"`
	State           TaskState           `json:"state"`
	Cancellation    TaskCancellation    `json:"cancellation"`
	Progress        TaskProgress        `json:"progress"`
	HasResult       bool                `json:"hasResult"`
	ExecutionCounts TaskExecutionCounts `json:"executionCounts"`
	CreatedAt       time.Time           `json:"createdAt"`
	UpdatedAt       time.Time           `json:"updatedAt"`
}

type TaskExecutionCounts struct {
	Total           int64 `json:"total"`
	PendingDispatch int64 `json:"pendingDispatch"`
	Dispatched      int64 `json:"dispatched"`
	Running         int64 `json:"running"`
	Succeeded       int64 `json:"succeeded"`
	Failed          int64 `json:"failed"`
	Stalled         int64 `json:"stalled"`
	Cancelled       int64 `json:"cancelled"`
}

type TaskExecutionPage struct {
	SchemaVersion int                    `json:"schemaVersion"`
	EntityVersion int64                  `json:"entityVersion"`
	TaskID        string                 `json:"taskId"`
	Executions    []TaskExecutionSummary `json:"executions"`
	NextCursor    string                 `json:"nextCursor,omitempty"`
}

func (c *Client) CreateTask(ctx context.Context, request TaskCreateRequest) (TaskSnapshot, error) {
	service, err := c.taskService()
	if err != nil {
		return TaskSnapshot{}, err
	}
	snapshot, err := service.CreateSnapshot(ctx, taskapp.CreateInput{
		ID:                domaintask.ID(request.ID),
		Type:              request.Type,
		OwnerID:           request.OwnerID,
		DefinitionVersion: request.DefinitionVersion,
	})
	return publicTaskSnapshot(snapshot), err
}

func (c *Client) GetTask(ctx context.Context, id string) (TaskSnapshot, error) {
	service, err := c.taskService()
	if err != nil {
		return TaskSnapshot{}, err
	}
	snapshot, err := service.Get(ctx, domaintask.ID(id))
	return publicTaskSnapshot(snapshot), err
}

func (c *Client) GetTaskSummary(ctx context.Context, id string) (TaskSummary, error) {
	service, err := c.taskService()
	if err != nil {
		return TaskSummary{}, err
	}
	summary, err := service.GetSummary(ctx, domaintask.ID(id))
	return publicTaskSummary(summary), err
}

func (c *Client) ListTaskExecutions(
	ctx context.Context, taskID, cursor string, limit int,
) (TaskExecutionPage, error) {
	service, err := c.taskService()
	if err != nil {
		return TaskExecutionPage{}, err
	}
	page, err := service.ListExecutionsPage(ctx, domaintask.ID(taskID), cursor, limit)
	return publicTaskExecutionPage(page), err
}

func (c *Client) CreateTaskExecution(
	ctx context.Context,
	taskID string,
	request TaskExecutionCreateRequest,
) (TaskSnapshot, error) {
	service, err := c.taskService()
	if err != nil {
		return TaskSnapshot{}, err
	}
	snapshot, err := service.CreateExecutionSnapshot(ctx, taskapp.CreateExecutionInput{
		ID:      execution.ID(request.ID),
		TaskID:  domaintask.ID(taskID),
		Runtime: request.Runtime,
		Trace:   traceContextFrom(request.TraceParent, request.TraceState),
	})
	return publicTaskSnapshot(snapshot), err
}

// traceContextFrom parses a caller-supplied trace context and discards anything
// malformed.
//
// Dropping rather than reporting is deliberate at this boundary. The header is
// produced by whatever sits in front of the adopter's application, and a proxy
// that mangles it must not be able to stop Tasks from being created. The cost
// of the lenient choice is a missing join key on one attempt; the cost of the
// strict one is refusing real work over a diagnostic field.
func traceContextFrom(traceParent, traceState string) correlation.TraceContext {
	trace, err := correlation.ParseTraceParent(traceParent)
	if err != nil {
		return correlation.TraceContext{}
	}
	withState, err := trace.WithTraceState(traceState)
	if err != nil {
		// An oversized vendor list is dropped on its own. The traceparent is
		// what an investigation joins on, and it is still good.
		return trace
	}
	return withState
}

func (c *Client) BindTaskExecution(
	ctx context.Context,
	executionID string,
	binding TaskExecutionBinding,
) (TaskSnapshot, error) {
	service, err := c.taskService()
	if err != nil {
		return TaskSnapshot{}, err
	}
	snapshot, err := service.BindExecutionSnapshot(
		ctx,
		execution.ID(executionID),
		execution.RuntimeReference{
			Runtime:    binding.Runtime,
			JobID:      binding.JobID,
			ExternalID: binding.ExternalID,
		},
	)
	return publicTaskSnapshot(snapshot), err
}

func (c *Client) LookupTaskExecution(
	ctx context.Context,
	runtime, externalID string,
) (TaskExecution, error) {
	service, err := c.taskService()
	if err != nil {
		return TaskExecution{}, err
	}
	record, err := service.LookupExternalExecution(ctx, runtime, externalID)
	return publicTaskExecution(record), err
}

func (c *Client) GetTaskExecution(ctx context.Context, id string) (TaskExecution, error) {
	service, err := c.taskService()
	if err != nil {
		return TaskExecution{}, err
	}
	record, err := service.GetExecution(ctx, execution.ID(id))
	return publicTaskExecution(record), err
}

func (c *Client) TransitionTaskExecution(
	ctx context.Context,
	id string,
	expectedVersion int64,
	state string,
) (TaskSnapshot, error) {
	service, err := c.taskService()
	if err != nil {
		return TaskSnapshot{}, err
	}
	snapshot, err := service.TransitionExecutionSnapshot(
		ctx, execution.ID(id), expectedVersion, execution.State(state),
	)
	return publicTaskSnapshot(snapshot), err
}

// AttachTaskExecutionResult records where one attempt's own output landed.
// Use it for fan-out items; AttachTaskResult stays the aggregate answer.
func (c *Client) AttachTaskExecutionResult(
	ctx context.Context,
	executionID string,
	expectedVersion int64,
	reference string,
) (TaskSnapshot, error) {
	service, err := c.taskService()
	if err != nil {
		return TaskSnapshot{}, err
	}
	snapshot, err := service.AttachExecutionResult(
		ctx, execution.ID(executionID), expectedVersion, reference,
	)
	return publicTaskSnapshot(snapshot), err
}

// FailTaskExecution is TransitionTaskExecution to failed plus the reason the
// user is owed for this item.
func (c *Client) FailTaskExecution(
	ctx context.Context,
	executionID string,
	expectedVersion int64,
	reason string,
) (TaskSnapshot, error) {
	service, err := c.taskService()
	if err != nil {
		return TaskSnapshot{}, err
	}
	snapshot, err := service.FailExecutionSnapshot(
		ctx, execution.ID(executionID), expectedVersion, reason,
	)
	return publicTaskSnapshot(snapshot), err
}

// GetTaskExecutionResults answers "what happened to each item" in one read.
func (c *Client) GetTaskExecutionResults(
	ctx context.Context,
	taskID string,
) (TaskExecutionResults, error) {
	service, err := c.taskService()
	if err != nil {
		return TaskExecutionResults{}, err
	}
	results, err := service.ListExecutionResults(ctx, domaintask.ID(taskID))
	return publicTaskExecutionResults(results), err
}

func (c *Client) AttachTaskResult(
	ctx context.Context,
	id string,
	expectedVersion int64,
	reference string,
) (TaskResult, error) {
	service, err := c.taskService()
	if err != nil {
		return TaskResult{}, err
	}
	result, err := service.AttachResult(
		ctx,
		domaintask.ID(id),
		expectedVersion,
		reference,
	)
	return publicTaskResult(result), err
}

func (c *Client) GetTaskResult(ctx context.Context, id string) (TaskResult, error) {
	service, err := c.taskService()
	if err != nil {
		return TaskResult{}, err
	}
	result, err := service.GetResult(ctx, domaintask.ID(id))
	return publicTaskResult(result), err
}

func (c *Client) ReportTaskProgress(
	ctx context.Context,
	id string,
	expectedVersion int64,
	progress TaskProgress,
) (TaskSnapshot, error) {
	service, err := c.taskService()
	if err != nil {
		return TaskSnapshot{}, err
	}
	domainProgress := domaintask.Progress{
		Completed: progress.Completed,
		Message:   progress.Message,
	}
	if progress.Total != nil {
		domainProgress.Total = *progress.Total
		domainProgress.HasTotal = true
	}
	snapshot, err := service.UpdateProgress(
		ctx,
		domaintask.ID(id),
		expectedVersion,
		domainProgress,
	)
	return publicTaskSnapshot(snapshot), err
}

func (c *Client) QueueTask(ctx context.Context, id string, expectedVersion int64) (TaskSnapshot, error) {
	return c.transitionTask(ctx, id, expectedVersion, domaintask.Queued)
}

func (c *Client) StartTask(ctx context.Context, id string, expectedVersion int64) (TaskSnapshot, error) {
	return c.transitionTask(ctx, id, expectedVersion, domaintask.Running)
}

func (c *Client) CompleteTask(ctx context.Context, id string, expectedVersion int64) (TaskSnapshot, error) {
	return c.transitionTask(ctx, id, expectedVersion, domaintask.Succeeded)
}

// MarkTaskUncertain records that technical execution ended without enough
// evidence to claim the real-world result. It is deliberately not a failure.
func (c *Client) MarkTaskUncertain(ctx context.Context, id string, expectedVersion int64) (TaskSnapshot, error) {
	return c.transitionTask(ctx, id, expectedVersion, domaintask.Uncertain)
}

func (c *Client) FailTask(ctx context.Context, id string, expectedVersion int64) (TaskSnapshot, error) {
	return c.transitionTask(ctx, id, expectedVersion, domaintask.Failed)
}

// RequestTaskCancellation is idempotent: repeating it on a Task that already
// carries the request returns the current snapshot unchanged.
func (c *Client) RequestTaskCancellation(ctx context.Context, id string, expectedVersion int64) (TaskSnapshot, error) {
	service, err := c.taskService()
	if err != nil {
		return TaskSnapshot{}, err
	}
	snapshot, err := service.RequestCancellation(ctx, domaintask.ID(id), expectedVersion)
	return publicTaskSnapshot(snapshot), err
}

func (c *Client) CancelTask(ctx context.Context, id string, expectedVersion int64) (TaskSnapshot, error) {
	return c.transitionTask(ctx, id, expectedVersion, domaintask.Cancelled)
}

func (c *Client) ResolveTaskCancellation(
	ctx context.Context,
	id string,
	expectedVersion int64,
	status string,
	reason string,
) (TaskSnapshot, error) {
	service, err := c.taskService()
	if err != nil {
		return TaskSnapshot{}, err
	}
	snapshot, err := service.ResolveCancellation(
		ctx,
		domaintask.ID(id),
		expectedVersion,
		domaintask.CancellationStatus(status),
		reason,
	)
	return publicTaskSnapshot(snapshot), err
}

func (c *Client) transitionTask(
	ctx context.Context,
	id string,
	expectedVersion int64,
	to domaintask.State,
) (TaskSnapshot, error) {
	service, err := c.taskService()
	if err != nil {
		return TaskSnapshot{}, err
	}
	snapshot, err := service.Transition(ctx, domaintask.ID(id), expectedVersion, to)
	return publicTaskSnapshot(snapshot), err
}

func (c *Client) taskService() (*taskapp.Service, error) {
	if c == nil || c.tasks == nil {
		return nil, errors.New("rhinoq task store is not configured")
	}
	return c.tasks, nil
}

func publicTaskSnapshot(snapshot taskcontract.Snapshot) TaskSnapshot {
	executions := make([]TaskExecutionSummary, len(snapshot.Executions))
	for i, attempt := range snapshot.Executions {
		executions[i] = TaskExecutionSummary{
			ID:            attempt.ID,
			Attempt:       attempt.Attempt,
			Runtime:       attempt.Runtime,
			State:         attempt.State,
			Version:       attempt.Version,
			HasResult:     attempt.HasResult,
			FailureReason: attempt.FailureReason,
			TraceID:       attempt.TraceID,
		}
	}
	return TaskSnapshot{
		SchemaVersion: snapshot.SchemaVersion,
		EntityVersion: snapshot.EntityVersion,
		ID:            snapshot.ID,
		Type:          snapshot.Type,
		OwnerID:       snapshot.OwnerID,
		State:         TaskState(snapshot.State),
		Cancellation: TaskCancellation{
			Status: snapshot.Cancellation.Status,
			Reason: snapshot.Cancellation.Reason,
		},
		Progress: TaskProgress{
			Completed: snapshot.Progress.Completed,
			Total:     snapshot.Progress.Total,
			Message:   snapshot.Progress.Message,
		},
		HasResult:  snapshot.HasResult,
		Executions: executions,
		CreatedAt:  snapshot.CreatedAt,
		UpdatedAt:  snapshot.UpdatedAt,
	}
}

func publicTaskSummary(summary taskcontract.Summary) TaskSummary {
	return TaskSummary{
		SchemaVersion: summary.SchemaVersion, EntityVersion: summary.EntityVersion,
		ID: summary.ID, Type: summary.Type, OwnerID: summary.OwnerID,
		State:        TaskState(summary.State),
		Cancellation: TaskCancellation{Status: summary.Cancellation.Status, Reason: summary.Cancellation.Reason},
		Progress:     TaskProgress{Completed: summary.Progress.Completed, Total: summary.Progress.Total, Message: summary.Progress.Message},
		HasResult:    summary.HasResult, CreatedAt: summary.CreatedAt, UpdatedAt: summary.UpdatedAt,
		ExecutionCounts: TaskExecutionCounts{
			Total:           summary.ExecutionCounts.Total,
			PendingDispatch: summary.ExecutionCounts.PendingDispatch,
			Dispatched:      summary.ExecutionCounts.Dispatched,
			Running:         summary.ExecutionCounts.Running,
			Succeeded:       summary.ExecutionCounts.Succeeded,
			Failed:          summary.ExecutionCounts.Failed,
			Stalled:         summary.ExecutionCounts.Stalled,
			Cancelled:       summary.ExecutionCounts.Cancelled,
		},
	}
}

func publicTaskExecutionPage(page taskcontract.ExecutionPage) TaskExecutionPage {
	items := make([]TaskExecutionSummary, len(page.Executions))
	for i, attempt := range page.Executions {
		items[i] = TaskExecutionSummary{
			ID: attempt.ID, Attempt: attempt.Attempt, Runtime: attempt.Runtime,
			State: attempt.State, Version: attempt.Version, HasResult: attempt.HasResult,
			FailureReason: attempt.FailureReason,
			TraceID:       attempt.TraceID,
		}
	}
	return TaskExecutionPage{
		SchemaVersion: page.SchemaVersion, EntityVersion: page.EntityVersion,
		TaskID: page.TaskID, Executions: items, NextCursor: page.NextCursor,
	}
}

func publicTaskExecution(record execution.Record) TaskExecution {
	return TaskExecution{
		ID: record.ID.String(), TaskID: record.TaskID, Runtime: record.Runtime,
		State: record.State.String(), Version: record.Version,
	}
}

func publicTaskExecutionResults(results taskcontract.ExecutionResults) TaskExecutionResults {
	executions := make([]TaskExecutionResult, len(results.Executions))
	for i, item := range results.Executions {
		executions[i] = TaskExecutionResult{
			ExecutionID:   item.ExecutionID,
			Attempt:       item.Attempt,
			State:         item.State,
			Reference:     item.Reference,
			FailureReason: item.FailureReason,
			UpdatedAt:     item.UpdatedAt,
		}
	}
	return TaskExecutionResults{
		SchemaVersion: results.SchemaVersion,
		EntityVersion: results.EntityVersion,
		TaskID:        results.TaskID,
		Executions:    executions,
	}
}

func publicTaskResult(result taskcontract.Result) TaskResult {
	return TaskResult{
		SchemaVersion: result.SchemaVersion,
		EntityVersion: result.EntityVersion,
		TaskID:        result.TaskID,
		Reference:     result.Reference,
		UpdatedAt:     result.UpdatedAt,
	}
}
