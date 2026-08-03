package unit

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/madebyduy/RhinoQ/pkg/rhinoq"
)

func registerDeletableRule(t *testing.T, integrity *rhinoq.IntegrityClient, id string) rhinoq.RuleRecord {
	t.Helper()
	record, err := integrity.RegisterRule(context.Background(), rhinoq.RuleDefinition{
		ID: id, Name: id, Scope: rhinoq.RuleScopeTable, SubjectType: "report",
		Query: `SELECT id::text AS subject_id, output_url IS NULL AS violated,
			'{}'::jsonb AS evidence
			FROM completed_reports
			WHERE created_at >= $1 AND id::text > $2
			ORDER BY id LIMIT $3`,
		BaselineAt: time.Now().UTC(), Every: 5 * time.Minute,
	})
	if err != nil {
		t.Fatalf("register %s: %v", id, err)
	}
	return record
}

// A trial is where people create Rules they never meant to keep. Without a
// delete the list only grows, and an operator who cannot clean it stops reading
// it - which is worse than the probe Rule they were trying to remove.
func TestDeleteRemovesAProbeRuleAndItsDerivedRows(t *testing.T) {
	integrity := rhinoq.NewInMemoryIntegrity()
	registerDeletableRule(t, integrity, "probe-rule")

	plan, err := integrity.DeleteRule(context.Background(), rhinoq.RuleDeleteRequest{
		ID: "probe-rule", DryRun: true,
	})
	if err != nil {
		t.Fatalf("plan the deletion: %v", err)
	}
	if plan.Applied || len(plan.Versions) != 1 || plan.Versions[0] != 1 {
		t.Fatalf("a dry run must report v1 and change nothing: %+v", plan)
	}
	if _, found, _ := integrity.GetRule(context.Background(), "probe-rule"); !found {
		t.Fatal("a dry run deleted the Rule it was only supposed to describe")
	}

	deletion, err := integrity.DeleteRule(context.Background(), rhinoq.RuleDeleteRequest{
		ID: "probe-rule",
	})
	if err != nil {
		t.Fatalf("delete the Rule: %v", err)
	}
	if !deletion.Applied {
		t.Fatalf("the applied deletion did not report itself as applied: %+v", deletion)
	}
	if _, found, _ := integrity.GetRule(context.Background(), "probe-rule"); found {
		t.Fatal("the Rule survived its own deletion")
	}
}

// Re-registering appends a version rather than editing one, so a delete of a
// single version must leave the others - and the Rule - alone.
func TestDeleteCanRemoveOneVersionWithoutTheRule(t *testing.T) {
	integrity := rhinoq.NewInMemoryIntegrity()
	registerDeletableRule(t, integrity, "versioned-rule")
	second := registerDeletableRule(t, integrity, "versioned-rule")
	if second.Version != 2 {
		t.Fatalf("re-registering must append a version, got v%d", second.Version)
	}

	deletion, err := integrity.DeleteRule(context.Background(), rhinoq.RuleDeleteRequest{
		ID: "versioned-rule", Version: 2,
	})
	if err != nil {
		t.Fatalf("delete v2: %v", err)
	}
	if len(deletion.Versions) != 1 || deletion.Versions[0] != 2 {
		t.Fatalf("only v2 was in scope: %+v", deletion)
	}
	record, found, err := integrity.GetRule(context.Background(), "versioned-rule")
	if err != nil || !found || record.Version != 1 {
		t.Fatalf("v1 must survive a v2 delete: found=%v record=%+v err=%v", found, record, err)
	}
}

func TestDeleteReportsAMissingRuleRatherThanSucceedingQuietly(t *testing.T) {
	integrity := rhinoq.NewInMemoryIntegrity()
	if _, err := integrity.DeleteRule(context.Background(), rhinoq.RuleDeleteRequest{
		ID: "never-existed",
	}); !errors.Is(err, rhinoq.ErrRuleNotFound) {
		t.Fatalf("deleting nothing must not read as success: %v", err)
	}
}
