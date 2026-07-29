package unit

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/madebyduy/RhinoQ/pkg/rhinoq"
)

type taskContractV1 struct {
	Snapshot rhinoq.TaskSnapshot `json:"snapshot"`
	Result   rhinoq.TaskResult   `json:"result"`
}

func TestPublicTaskContractMatchesGoldenV1(t *testing.T) {
	t.Parallel()
	total := int64(10)
	updatedAt := time.Date(2026, 7, 29, 14, 2, 0, 0, time.UTC)
	contract := taskContractV1{
		Snapshot: rhinoq.TaskSnapshot{
			SchemaVersion: 1,
			EntityVersion: 7,
			ID:            "task-contract-01",
			Type:          "report.export",
			State:         rhinoq.TaskRunning,
			Progress: rhinoq.TaskProgress{
				Completed: 4,
				Total:     &total,
				Message:   "rendering",
			},
			HasResult: true,
			Executions: []rhinoq.TaskExecutionSummary{{
				ID:      "execution-contract-01",
				Attempt: 1,
				Runtime: "bullmq",
				State:   "running",
				Version: 3,
			}},
			CreatedAt: time.Date(2026, 7, 29, 14, 0, 0, 0, time.UTC),
			UpdatedAt: updatedAt,
		},
		Result: rhinoq.TaskResult{
			SchemaVersion: 1,
			EntityVersion: 7,
			TaskID:        "task-contract-01",
			Reference:     "s3://reports/task-contract-01.pdf",
			UpdatedAt:     updatedAt,
		},
	}
	actual, err := json.MarshalIndent(contract, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	actual = append(actual, '\n')
	goldenPath := filepath.Join(
		repositoryRoot(t), "testdata", "contracts", "task-contract-v1.json",
	)
	expected, err := os.ReadFile(goldenPath)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(actual, expected) {
		t.Fatalf(
			"Task wire contract drifted; update schema/version and both SDKs before changing %s\nactual:\n%s",
			goldenPath,
			actual,
		)
	}
}
