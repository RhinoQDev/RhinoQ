package integration_test

import (
	"context"
	"fmt"
	"testing"

	"github.com/madebyduy/RhinoQ/pkg/rhinoq"
)

func TestTaskSummaryStaysSmallAndExecutionsPageWithoutOverlap(t *testing.T) {
	client := rhinoq.NewInMemory()
	ctx := context.Background()
	created, err := client.CreateTask(ctx, rhinoq.TaskCreateRequest{ID: "fanout-page", Type: "export", DefinitionVersion: 1})
	if err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 5; i++ {
		if _, err = client.CreateTaskExecution(ctx, created.ID, rhinoq.TaskExecutionCreateRequest{ID: fmt.Sprintf("exec-%d", i), Runtime: "test"}); err != nil {
			t.Fatal(err)
		}
	}
	summary, err := client.GetTaskSummary(ctx, created.ID)
	if err != nil {
		t.Fatal(err)
	}
	if summary.EntityVersion != 6 {
		t.Fatalf("summary version=%d", summary.EntityVersion)
	}
	if summary.ExecutionCounts.Total != 5 || summary.ExecutionCounts.PendingDispatch != 5 {
		t.Fatalf("stored aggregate counts=%+v", summary.ExecutionCounts)
	}
	seen := map[string]bool{}
	cursor := ""
	for {
		page, e := client.ListTaskExecutions(ctx, created.ID, cursor, 2)
		if e != nil {
			t.Fatal(e)
		}
		if page.EntityVersion != summary.EntityVersion {
			t.Fatalf("page version=%d summary=%d", page.EntityVersion, summary.EntityVersion)
		}
		for _, item := range page.Executions {
			if seen[item.ID] {
				t.Fatalf("duplicate %s", item.ID)
			}
			seen[item.ID] = true
		}
		if page.NextCursor == "" {
			break
		}
		cursor = page.NextCursor
	}
	if len(seen) != 5 {
		t.Fatalf("got %d executions", len(seen))
	}
	if _, err = client.ListTaskExecutions(ctx, created.ID, "not-a-cursor", 2); err == nil {
		t.Fatal("invalid cursor accepted")
	}
}
