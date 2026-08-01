package benchmarks

import (
	"context"
	"strconv"
	"testing"
	"time"

	"github.com/madebyduy/RhinoQ/internal/adapters/memory"
	"github.com/madebyduy/RhinoQ/internal/domain/task"
)

func BenchmarkTaskApplyProgress(b *testing.B) {
	now := time.Unix(1, 0).UTC()
	record, err := task.NewRecord(task.Spec{
		ID: "bench-task", Type: "benchmark", DefinitionVersion: 1, Now: now,
	})
	if err != nil {
		b.Fatal(err)
	}
	record, err = record.Transition(task.Queued, now)
	if err != nil {
		b.Fatal(err)
	}
	record, err = record.Transition(task.Running, now)
	if err != nil {
		b.Fatal(err)
	}
	b.ReportAllocs()
	b.ResetTimer()
	for index := 0; index < b.N; index++ {
		record, err = record.ApplyProgress(task.Progress{Completed: int64(index)}, now)
		if err != nil {
			b.Fatal(err)
		}
	}
}

func BenchmarkTaskDuplicateProgress(b *testing.B) {
	now := time.Unix(1, 0).UTC()
	record, err := task.NewRecord(task.Spec{
		ID: "bench-task", Type: "benchmark", DefinitionVersion: 1, Now: now,
	})
	if err != nil {
		b.Fatal(err)
	}
	record, _ = record.Transition(task.Queued, now)
	record, _ = record.Transition(task.Running, now)
	progress := task.Progress{Completed: 42, Total: 100, HasTotal: true}
	record, _ = record.ApplyProgress(progress, now)
	b.ReportAllocs()
	b.ResetTimer()
	for index := 0; index < b.N; index++ {
		if !record.ProgressIsCurrent(progress) {
			b.Fatal("duplicate progress was not recognized")
		}
	}
}

func BenchmarkMemoryTaskStoreReadParallel(b *testing.B) {
	store := memory.NewTaskStore()
	now := time.Unix(1, 0).UTC()
	record, err := task.NewRecord(task.Spec{
		ID: "bench-task", Type: "benchmark", DefinitionVersion: 1, Now: now,
	})
	if err != nil {
		b.Fatal(err)
	}
	if _, err := store.CreateTask(context.Background(), record); err != nil {
		b.Fatal(err)
	}
	b.ReportAllocs()
	b.RunParallel(func(parallel *testing.PB) {
		for parallel.Next() {
			if _, found, err := store.GetTask(context.Background(), record.ID); err != nil || !found {
				b.Fatalf("read failed: found=%v err=%v", found, err)
			}
		}
	})
}

func BenchmarkMemoryTaskStoreCreate(b *testing.B) {
	now := time.Unix(1, 0).UTC()
	b.ReportAllocs()
	for index := 0; index < b.N; index++ {
		store := memory.NewTaskStore()
		record, err := task.NewRecord(task.Spec{
			ID: task.ID("bench-" + strconv.Itoa(index)), Type: "benchmark",
			DefinitionVersion: 1, Now: now,
		})
		if err != nil {
			b.Fatal(err)
		}
		if _, err := store.CreateTask(context.Background(), record); err != nil {
			b.Fatal(err)
		}
	}
}
