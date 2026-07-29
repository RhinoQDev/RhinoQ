package tasks

import (
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/madebyduy/RhinoQ/internal/domain/execution"
	"github.com/madebyduy/RhinoQ/internal/domain/task"
)

func TestSnapshotIsVersionedAndDoesNotLeakOwnershipOrRuntimeReferences(t *testing.T) {
	now := time.Date(2026, 7, 29, 14, 0, 0, 0, time.UTC)
	record, err := task.NewRecord(task.Spec{
		ID: "task-1", Type: "report.export", OwnerID: "secret-owner",
		DefinitionVersion: 1, Now: now,
	})
	if err != nil {
		t.Fatal(err)
	}
	attempt, err := execution.NewRecord(execution.Spec{
		ID: "exec-1", TaskID: record.ID.String(), Attempt: 1,
		Runtime: "bullmq", Now: now,
	})
	if err != nil {
		t.Fatal(err)
	}
	attempt, err = attempt.Bind(execution.RuntimeReference{
		Runtime: "bullmq", ExternalID: "private-bull-job-id",
	}, now.Add(time.Second))
	if err != nil {
		t.Fatal(err)
	}
	snapshot, err := newSnapshot(record, []execution.Record{attempt})
	if err != nil {
		t.Fatal(err)
	}
	encoded, err := json.Marshal(snapshot)
	if err != nil {
		t.Fatal(err)
	}
	text := string(encoded)
	if snapshot.SchemaVersion != 1 || snapshot.EntityVersion != record.Version {
		t.Fatalf("snapshot versions are missing: %+v", snapshot)
	}
	for _, secret := range []string{"secret-owner", "private-bull-job-id", "jobId", "externalId"} {
		if strings.Contains(text, secret) {
			t.Fatalf("snapshot leaked internal data %q: %s", secret, text)
		}
	}
}

func TestSnapshotUsesOmittedTotalForIndeterminateProgress(t *testing.T) {
	now := time.Date(2026, 7, 29, 14, 0, 0, 0, time.UTC)
	record, err := task.NewRecord(task.Spec{
		ID: "task-1", Type: "import", DefinitionVersion: 1, Now: now,
	})
	if err != nil {
		t.Fatal(err)
	}
	snapshot, err := newSnapshot(record, nil)
	if err != nil {
		t.Fatal(err)
	}
	encoded, err := json.Marshal(snapshot)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(encoded), `"total"`) {
		t.Fatalf("indeterminate progress must omit total: %s", encoded)
	}
}
