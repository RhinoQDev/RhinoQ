package postgres_test

import (
	"context"
	"sync"
	"testing"
	"time"

	"github.com/madebyduy/RhinoQ/pkg/rhinoq"
)

func TestFindingsAreAtomicDeduplicatedAndAuditableInPostgreSQL(t *testing.T) {
	client := newClient(t)
	ctx := context.Background()
	key := rhinoq.FindingKey{
		RuleID: "media-renditions-complete", SubjectType: "media",
		SubjectID: "media-7", InvariantVersion: 3,
	}
	now := time.Date(2026, 7, 28, 10, 0, 0, 0, time.UTC)

	for index := 0; index < 2; index++ {
		if _, err := client.ObserveFinding(ctx, rhinoq.FindingObservation{
			FindingKey: key, Evidence: `{"missing":["mobile"]}`,
			ObservedAt: now.Add(time.Duration(index) * time.Minute),
		}); err != nil {
			t.Fatalf("observe finding %d: %v", index, err)
		}
	}
	record, err := client.TransitionFinding(ctx, key, rhinoq.FindingTransition{
		Status: rhinoq.FindingIgnored, Actor: "ops@example.com",
		Reason: "provider maintenance", Until: now.Add(time.Hour),
		At: now.Add(2 * time.Minute),
	})
	if err != nil {
		t.Fatal(err)
	}
	if record.OccurrenceCount != 2 || record.Status != rhinoq.FindingIgnored {
		t.Fatalf("PostgreSQL must fold observations into one finding: %+v", record)
	}

	visible, err := client.ListFindings(ctx, rhinoq.FindingQuery{Limit: 20})
	if err != nil {
		t.Fatal(err)
	}
	if len(visible) != 0 {
		t.Fatalf("active suppression must stay out of the default inbox: %+v", visible)
	}
	all, err := client.ListFindings(ctx, rhinoq.FindingQuery{
		IncludeSuppressed: true, Limit: 20,
	})
	if err != nil || len(all) != 1 {
		t.Fatalf("audit query must include the suppressed finding: len=%d err=%v", len(all), err)
	}
	events, err := client.FindingHistory(ctx, key, 0, 20)
	if err != nil || len(events) != 3 {
		t.Fatalf("observation and decision history must be durable: len=%d err=%v", len(events), err)
	}
}

func TestConcurrentFirstObservationsFoldIntoOnePostgreSQLFinding(t *testing.T) {
	client := newClient(t)
	key := rhinoq.FindingKey{
		RuleID: "account-must-provision", SubjectType: "account",
		SubjectID: "acct-race", InvariantVersion: 1,
	}
	const observers = 12
	var group sync.WaitGroup
	errorsFound := make(chan error, observers)
	group.Add(observers)
	for index := 0; index < observers; index++ {
		go func(index int) {
			defer group.Done()
			_, err := client.ObserveFinding(context.Background(), rhinoq.FindingObservation{
				FindingKey: key, Evidence: `{"provisioned":false}`,
				ObservedAt: time.Date(2026, 7, 28, 11, 0, index, 0, time.UTC),
			})
			errorsFound <- err
		}(index)
	}
	group.Wait()
	close(errorsFound)
	for err := range errorsFound {
		if err != nil {
			t.Fatalf("concurrent observation: %v", err)
		}
	}
	records, err := client.ListFindings(context.Background(), rhinoq.FindingQuery{
		SubjectID: "acct-race", Limit: 10,
	})
	if err != nil || len(records) != 1 {
		t.Fatalf("expected one finding: len=%d err=%v", len(records), err)
	}
	if records[0].OccurrenceCount != observers {
		t.Fatalf("expected %d folded observations, got %+v", observers, records[0])
	}
}
