package ports

import (
	"context"
	"time"

	"github.com/madebyduy/RhinoQ/internal/domain/taskschedule"
)

// TaskScheduleStore owns definitions and fenced occurrence leases. Stores use
// their own database clock when deciding due work; now is for memory/test ports.
type TaskScheduleStore interface {
	SaveTaskSchedule(context.Context, taskschedule.Record) (taskschedule.Record, error)
	GetTaskSchedule(context.Context, string, string) (taskschedule.Record, bool, error)
	ListTaskSchedules(context.Context, string, int) ([]taskschedule.Record, error)
	SetTaskScheduleEnabled(context.Context, string, string, int64, bool) (taskschedule.Record, error)
	UpdateTaskSchedule(context.Context, string, string, int64, time.Duration, time.Time) (taskschedule.Record, error)
	UpdateTaskScheduleCalendar(context.Context, string, string, int64, string, string, time.Time) (taskschedule.Record, error)
	DeleteTaskSchedule(context.Context, string, string, int64) error
	TaskScheduleStats(context.Context) (taskschedule.Stats, error)
	ClaimDueTaskSchedules(context.Context, string, time.Time, time.Duration, int) ([]taskschedule.Lease, error)
	CompleteTaskSchedule(context.Context, taskschedule.Lease, time.Time) error
	FailTaskSchedule(context.Context, taskschedule.Lease, time.Duration, string) error
}
