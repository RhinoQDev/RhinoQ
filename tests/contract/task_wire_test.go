package contract

import (
	"encoding/json"
	"testing"
	"time"

	"github.com/madebyduy/RhinoQ/pkg/rhinoq"
)

type taskContractV1 struct {
	Snapshot         rhinoq.TaskSnapshot         `json:"snapshot"`
	Result           rhinoq.TaskResult           `json:"result"`
	ExecutionResults rhinoq.TaskExecutionResults `json:"executionResults"`
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
			OwnerID:       "tenant-acme",
			State:         rhinoq.TaskRunning,
			Cancellation: rhinoq.TaskCancellation{
				Status: "none",
			},
			Progress: rhinoq.TaskProgress{
				Completed: 4,
				Total:     &total,
				Message:   "rendering",
			},
			HasResult: true,
			// Three attempts pin the fan-out wire shape: one still running, one
			// that produced an artifact, and one that failed with a reason. The
			// storage reference is deliberately absent here.
			Executions: []rhinoq.TaskExecutionSummary{{
				ID:      "execution-contract-01",
				Attempt: 1,
				Runtime: "bullmq",
				State:   "running",
				Version: 3,
			}, {
				ID:        "execution-contract-02",
				Attempt:   2,
				Runtime:   "bullmq",
				State:     "succeeded",
				Version:   4,
				HasResult: true,
			}, {
				ID:            "execution-contract-03",
				Attempt:       3,
				Runtime:       "bullmq",
				State:         "failed",
				Version:       4,
				FailureReason: "source mirror returned 404 after 3 attempts",
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
		ExecutionResults: rhinoq.TaskExecutionResults{
			SchemaVersion: 1,
			EntityVersion: 7,
			TaskID:        "task-contract-01",
			Executions: []rhinoq.TaskExecutionResult{{
				ExecutionID: "execution-contract-01",
				Attempt:     1,
				State:       "running",
				UpdatedAt:   updatedAt,
			}, {
				ExecutionID: "execution-contract-02",
				Attempt:     2,
				State:       "succeeded",
				Reference:   "s3://reports/task-contract-01/item-2.mp4",
				UpdatedAt:   updatedAt,
			}, {
				ExecutionID:   "execution-contract-03",
				Attempt:       3,
				State:         "failed",
				FailureReason: "source mirror returned 404 after 3 attempts",
				UpdatedAt:     updatedAt,
			}},
		},
	}
	actual, err := json.MarshalIndent(contract, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	assertGolden(t, "task-contract-v1.json", append(actual, '\n'))
}
