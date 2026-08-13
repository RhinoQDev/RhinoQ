package rhinoq

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/madebyduy/RhinoQ/internal/ports"
)

func TestNativeRecurringDispatcherUsesOccurrenceAsIdempotencyIdentity(t *testing.T) {
	client := NewInMemory()
	dispatch, err := client.NativeRecurringDispatcher(NativeRecurringDispatchConfig{
		QueueForTask: map[string]string{"report.export": "reports"},
	})
	if err != nil {
		t.Fatal(err)
	}
	occurrence := RecurringTaskOccurrence{
		ScheduleID: "daily-report", TaskName: "report.export", TenantID: "tenant-a",
		OccurrenceID: "occ-1", Payload: json.RawMessage(`{"reportId":"42"}`),
	}
	if err := dispatch(context.Background(), occurrence); err != nil {
		t.Fatal(err)
	}
	if err := dispatch(context.Background(), occurrence); err != nil {
		t.Fatal(err)
	}
	jobs, err := client.store.ListJobs(context.Background(), ports.ListJobsInput{QueueName: "reports", Limit: 10})
	if err != nil {
		t.Fatal(err)
	}
	if len(jobs) != 1 {
		t.Fatalf("got %d jobs after duplicate dispatch, want 1", len(jobs))
	}
	if jobs[0].JobName != "report.export" || jobs[0].GroupKey != "tenant-a" || jobs[0].CorrelationID != "daily-report" {
		t.Fatalf("unexpected recurring job identity: %#v", jobs[0])
	}
}

func TestNativeRecurringDispatcherFailsClosedForUnknownTask(t *testing.T) {
	dispatch, err := NewInMemory().NativeRecurringDispatcher(NativeRecurringDispatchConfig{
		QueueForTask: map[string]string{"report.export": "reports"},
	})
	if err != nil {
		t.Fatal(err)
	}
	err = dispatch(context.Background(), RecurringTaskOccurrence{TaskName: "email.send", OccurrenceID: "occ-1"})
	if err == nil {
		t.Fatal("unknown Task mapping must be refused")
	}
}
