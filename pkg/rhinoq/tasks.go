package rhinoq

import (
	"context"
	"errors"
	"time"

	taskapp "github.com/madebyduy/RhinoQ/internal/application/tasks"
	taskcontract "github.com/madebyduy/RhinoQ/internal/contracts/task"
	"github.com/madebyduy/RhinoQ/internal/domain/execution"
	domaintask "github.com/madebyduy/RhinoQ/internal/domain/task"
	"github.com/madebyduy/RhinoQ/internal/ports"
)

var (
	ErrTaskNotFound              = ports.ErrTaskNotFound
	ErrTaskResultNotFound        = ports.ErrTaskResultNotFound
	ErrTaskVersionConflict       = ports.ErrVersionConflict
	ErrTaskAlreadyExists         = ports.ErrAlreadyExists
	ErrExecutionAlreadyBound     = execution.ErrAlreadyBound
	ErrExecutionInvalidReference = execution.ErrInvalidReference
)

type TaskState string

const (
	TaskPending         TaskState = "pending"
	TaskQueued          TaskState = "queued"
	TaskRunning         TaskState = "running"
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
	ID      string `json:"id"`
	Attempt int    `json:"attempt"`
	Runtime string `json:"runtime"`
	State   string `json:"state"`
	Version int64  `json:"version"`
}

type TaskExecutionCreateRequest struct {
	ID      string `json:"id"`
	Runtime string `json:"runtime"`
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
	State         TaskState              `json:"state"`
	Progress      TaskProgress           `json:"progress"`
	HasResult     bool                   `json:"hasResult"`
	Executions    []TaskExecutionSummary `json:"executions"`
	CreatedAt     time.Time              `json:"createdAt"`
	UpdatedAt     time.Time              `json:"updatedAt"`
}

func (c *Client) CreateTask(ctx context.Context, request TaskCreateRequest) (TaskSnapshot, error) {
	service, err := c.taskService()
	if err != nil {
		return TaskSnapshot{}, err
	}
	record, err := service.Create(ctx, taskapp.CreateInput{
		ID:                domaintask.ID(request.ID),
		Type:              request.Type,
		OwnerID:           request.OwnerID,
		DefinitionVersion: request.DefinitionVersion,
	})
	if err != nil {
		return TaskSnapshot{}, err
	}
	snapshot, err := service.Get(ctx, record.ID)
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
	})
	return publicTaskSnapshot(snapshot), err
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

func (c *Client) FailTask(ctx context.Context, id string, expectedVersion int64) (TaskSnapshot, error) {
	return c.transitionTask(ctx, id, expectedVersion, domaintask.Failed)
}

func (c *Client) RequestTaskCancellation(ctx context.Context, id string, expectedVersion int64) (TaskSnapshot, error) {
	return c.transitionTask(ctx, id, expectedVersion, domaintask.CancelRequested)
}

func (c *Client) CancelTask(ctx context.Context, id string, expectedVersion int64) (TaskSnapshot, error) {
	return c.transitionTask(ctx, id, expectedVersion, domaintask.Cancelled)
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
			ID:      attempt.ID,
			Attempt: attempt.Attempt,
			Runtime: attempt.Runtime,
			State:   attempt.State,
			Version: attempt.Version,
		}
	}
	return TaskSnapshot{
		SchemaVersion: snapshot.SchemaVersion,
		EntityVersion: snapshot.EntityVersion,
		ID:            snapshot.ID,
		Type:          snapshot.Type,
		State:         TaskState(snapshot.State),
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

func publicTaskResult(result taskcontract.Result) TaskResult {
	return TaskResult{
		SchemaVersion: result.SchemaVersion,
		EntityVersion: result.EntityVersion,
		TaskID:        result.TaskID,
		Reference:     result.Reference,
		UpdatedAt:     result.UpdatedAt,
	}
}
