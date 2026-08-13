package rhinoq

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/madebyduy/RhinoQ/internal/domain/taskschedule"
	"github.com/madebyduy/RhinoQ/internal/runtime/taskscheduler"
)

type RecurringTaskRequest struct {
	ID, TaskName, OwnerID, TenantID string
	Payload                         json.RawMessage
	Every                           time.Duration
	Cron, Timezone                  string
	StartAt                         time.Time
}

type RecurringTaskOccurrence struct {
	ScheduleID, TaskName, OwnerID, TenantID, OccurrenceID string
	Payload                                               json.RawMessage
	ScheduledAt                                           time.Time
}

type RecurringTaskSchedule struct {
	ID, TaskName, OwnerID, TenantID string
	Payload                         json.RawMessage
	Every                           time.Duration
	Cron, Timezone                  string
	Enabled                         bool
	NextRunAt                       time.Time
	Version                         int64
}

type RecurringTaskStats struct {
	Enabled, Paused, Due, Leased, Failed int64
	OldestDueLag                         time.Duration
}

func (c *Client) RecurringTaskStats(ctx context.Context) (RecurringTaskStats, bool, error) {
	if c == nil || c.taskSchedules == nil {
		return RecurringTaskStats{}, false, nil
	}
	stats, err := c.taskSchedules.TaskScheduleStats(ctx)
	return RecurringTaskStats{Enabled: stats.Enabled, Paused: stats.Paused, Due: stats.Due, Leased: stats.Leased, Failed: stats.Failed, OldestDueLag: stats.OldestDueLag}, true, err
}

type RecurringTaskSchedulerConfig struct {
	Owner                             string
	PollInterval, Lease, ErrorBackoff time.Duration
	ClaimBatch                        int
	Dispatch                          func(context.Context, RecurringTaskOccurrence) error
	OnError                           func(error)
}

// NativeRecurringDispatchConfig maps public Task names to native PostgreSQL
// execution lanes. The mapping is explicit because a Task contract and a
// queue's capacity/concurrency policy are different concerns.
type NativeRecurringDispatchConfig struct {
	QueueForTask  map[string]string
	Priority      int
	ResourceClass string
}

// NativeRecurringDispatcher returns a scheduler callback for RhinoQ's native
// PostgreSQL queue. OccurrenceID is always used as the queue idempotency key,
// so a lost scheduler response or lease takeover converges on the same job.
func (c *Client) NativeRecurringDispatcher(config NativeRecurringDispatchConfig) (func(context.Context, RecurringTaskOccurrence) error, error) {
	if c == nil || c.store == nil {
		return nil, errors.New("rhinoq native queue store is required")
	}
	if len(config.QueueForTask) == 0 {
		return nil, errors.New("at least one recurring Task to queue mapping is required")
	}
	routes := make(map[string]string, len(config.QueueForTask))
	for taskName, queueName := range config.QueueForTask {
		if taskName == "" || queueName == "" {
			return nil, errors.New("recurring Task and queue names must not be empty")
		}
		routes[taskName] = queueName
	}
	return func(ctx context.Context, occurrence RecurringTaskOccurrence) error {
		queueName, ok := routes[occurrence.TaskName]
		if !ok {
			return errors.New("recurring Task has no native queue mapping: " + occurrence.TaskName)
		}
		if occurrence.OccurrenceID == "" {
			return errors.New("recurring Task occurrence id is required")
		}
		_, err := c.Enqueue(ctx, JobRequest{
			QueueName: queueName, JobName: occurrence.TaskName,
			GroupKey: occurrence.TenantID, Payload: append([]byte(nil), occurrence.Payload...),
			IdempotencyKey: occurrence.OccurrenceID, CorrelationID: occurrence.ScheduleID,
			Priority: config.Priority, ResourceClass: config.ResourceClass,
		})
		return err
	}, nil
}

func (c *Client) CreateRecurringTask(ctx context.Context, request RecurringTaskRequest) error {
	if c == nil || c.taskSchedules == nil {
		return errors.New("recurring Task schedule store is not configured")
	}
	record, err := taskschedule.New(taskschedule.Spec{ID: request.ID, TaskName: request.TaskName, OwnerID: request.OwnerID, TenantID: request.TenantID, Payload: request.Payload, Every: request.Every, Cron: request.Cron, Timezone: request.Timezone, StartAt: request.StartAt}, time.Now().UTC())
	if err != nil {
		return err
	}
	_, err = c.taskSchedules.SaveTaskSchedule(ctx, record)
	return err
}

func (c *Client) GetRecurringTask(ctx context.Context, tenantID, id string) (RecurringTaskSchedule, bool, error) {
	if c == nil || c.taskSchedules == nil {
		return RecurringTaskSchedule{}, false, errors.New("recurring Task schedule store is not configured")
	}
	record, ok, err := c.taskSchedules.GetTaskSchedule(ctx, tenantID, id)
	return publicRecurring(record), ok, err
}

func (c *Client) ListRecurringTasks(ctx context.Context, tenantID string, limit int) ([]RecurringTaskSchedule, error) {
	if c == nil || c.taskSchedules == nil {
		return nil, errors.New("recurring Task schedule store is not configured")
	}
	records, err := c.taskSchedules.ListTaskSchedules(ctx, tenantID, limit)
	if err != nil {
		return nil, err
	}
	result := make([]RecurringTaskSchedule, len(records))
	for i, r := range records {
		result[i] = publicRecurring(r)
	}
	return result, nil
}

func (c *Client) PauseRecurringTask(ctx context.Context, tenantID, id string, version int64) (RecurringTaskSchedule, error) {
	return c.setRecurringEnabled(ctx, tenantID, id, version, false)
}
func (c *Client) ResumeRecurringTask(ctx context.Context, tenantID, id string, version int64) (RecurringTaskSchedule, error) {
	return c.setRecurringEnabled(ctx, tenantID, id, version, true)
}
func (c *Client) setRecurringEnabled(ctx context.Context, tenantID, id string, version int64, enabled bool) (RecurringTaskSchedule, error) {
	if c == nil || c.taskSchedules == nil {
		return RecurringTaskSchedule{}, errors.New("recurring Task schedule store is not configured")
	}
	r, err := c.taskSchedules.SetTaskScheduleEnabled(ctx, tenantID, id, version, enabled)
	return publicRecurring(r), err
}
func (c *Client) UpdateRecurringTask(ctx context.Context, tenantID, id string, version int64, every time.Duration, nextRunAt time.Time) (RecurringTaskSchedule, error) {
	if c == nil || c.taskSchedules == nil {
		return RecurringTaskSchedule{}, errors.New("recurring Task schedule store is not configured")
	}
	r, err := c.taskSchedules.UpdateTaskSchedule(ctx, tenantID, id, version, every, nextRunAt)
	return publicRecurring(r), err
}
func (c *Client) UpdateRecurringTaskCalendar(ctx context.Context, tenantID, id string, version int64, expression, timezone string, after time.Time) (RecurringTaskSchedule, error) {
	if c == nil || c.taskSchedules == nil { return RecurringTaskSchedule{}, errors.New("recurring Task schedule store is not configured") }
	next, err := (taskschedule.Spec{Cron: expression, Timezone: timezone}).NextAfter(after)
	if err != nil { return RecurringTaskSchedule{}, err }
	r, err := c.taskSchedules.UpdateTaskScheduleCalendar(ctx, tenantID, id, version, expression, timezone, next)
	return publicRecurring(r), err
}
func (c *Client) DeleteRecurringTask(ctx context.Context, tenantID, id string, version int64) error {
	if c == nil || c.taskSchedules == nil {
		return errors.New("recurring Task schedule store is not configured")
	}
	return c.taskSchedules.DeleteTaskSchedule(ctx, tenantID, id, version)
}

func publicRecurring(r taskschedule.Record) RecurringTaskSchedule {
	return RecurringTaskSchedule{ID: r.ID, TaskName: r.TaskName, OwnerID: r.OwnerID, TenantID: r.TenantID, Payload: append(json.RawMessage(nil), r.Payload...), Every: r.Every, Cron: r.Cron, Timezone: r.Timezone, Enabled: r.Enabled, NextRunAt: r.NextRunAt, Version: r.Version}
}

func (c *Client) RunRecurringTaskScheduler(ctx context.Context, config RecurringTaskSchedulerConfig) error {
	if c == nil || c.taskSchedules == nil {
		return errors.New("recurring Task schedule store is not configured")
	}
	if config.Dispatch == nil {
		return errors.New("recurring Task dispatcher is required")
	}
	runner, err := taskscheduler.New(taskscheduler.Config{Store: c.taskSchedules, Owner: config.Owner, PollInterval: config.PollInterval, Lease: config.Lease, ErrorBackoff: config.ErrorBackoff, ClaimBatch: config.ClaimBatch, OnError: config.OnError,
		Dispatch: func(runCtx context.Context, lease taskschedule.Lease, occurrenceID string) error {
			return config.Dispatch(runCtx, RecurringTaskOccurrence{ScheduleID: lease.ScheduleID, TaskName: lease.TaskName, OwnerID: lease.OwnerID, TenantID: lease.TenantID, OccurrenceID: occurrenceID, Payload: append(json.RawMessage(nil), lease.Payload...), ScheduledAt: lease.Occurrence})
		},
	})
	if err != nil {
		return err
	}
	return runner.Run(ctx)
}
