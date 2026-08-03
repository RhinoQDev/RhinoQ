package memory

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/madebyduy/RhinoQ/internal/domain/finding"
	"github.com/madebyduy/RhinoQ/internal/domain/rule"
	"github.com/madebyduy/RhinoQ/internal/ports"
)

func deletableRule(version int) rule.Record {
	now := time.Now().UTC()
	return rule.Record{
		ID: "probe-rule", Version: version, Name: "Probe Rule",
		Scope: rule.TableScope, Status: rule.Draft, SubjectType: "report",
		Query: `SELECT id::text AS subject_id, output_url IS NULL AS violated,
			'{}'::jsonb AS evidence FROM completed_reports
			WHERE created_at >= $1 AND id::text > $2 ORDER BY id LIMIT $3`,
		BaselineAt: now, Every: 5 * time.Minute,
		CreatedAt: now, UpdatedAt: now,
	}
}

// Deleting an enabled Rule stops a check nobody decided to stop. Disabling is
// cheap, reversible and visible; the refusal makes that the only path, and it
// names the version so the operator does not have to go looking.
func TestDeleteRuleRefusesAnEnabledVersion(t *testing.T) {
	store := NewRuleStore()
	ctx := context.Background()
	if _, err := store.SaveRule(ctx, deletableRule(1)); err != nil {
		t.Fatalf("save rule: %v", err)
	}
	if _, err := store.SetRuleStatus(ctx, "probe-rule", 1, rule.Enabled, time.Now().UTC()); err != nil {
		t.Fatalf("enable rule: %v", err)
	}

	deletion, err := store.DeleteRule(ctx, rule.DeleteRequest{ID: "probe-rule"})
	if !errors.Is(err, rule.ErrRuleEnabled) {
		t.Fatalf("an enabled Rule must not be deletable: %v", err)
	}
	if len(deletion.EnabledVersions) != 1 || deletion.EnabledVersions[0] != 1 {
		t.Fatalf("the refusal must name what to disable: %+v", deletion)
	}
	if _, found, _ := store.GetRule(ctx, "probe-rule"); !found {
		t.Fatal("a refused deletion still removed the Rule")
	}
}

// A Finding records what an operator decided about real business state. It is
// keyed by rule id as free text precisely so it outlives a definition being
// rewritten, which is why discarding one has to be asked for out loud.
func TestDeleteRuleRefusesToDiscardFindingsImplicitly(t *testing.T) {
	store := NewRuleStore()
	findings := NewFindingStore()
	store.TrackRuleDependents(findings, NewSubjectOutcomeStore())
	ctx := context.Background()
	if _, err := store.SaveRule(ctx, deletableRule(1)); err != nil {
		t.Fatalf("save rule: %v", err)
	}
	if _, err := findings.ObserveFinding(ctx, finding.Observation{
		Key: finding.Key{
			RuleID: "probe-rule", SubjectType: "report", SubjectID: "report_2",
			ObservedInvariantVersion: 1,
		},
		Evidence: `{"hasOutput":false}`, ObservedAt: time.Now().UTC(),
	}); err != nil {
		t.Fatalf("observe finding: %v", err)
	}

	deletion, err := store.DeleteRule(ctx, rule.DeleteRequest{ID: "probe-rule"})
	if !errors.Is(err, rule.ErrFindingsRemain) {
		t.Fatalf("a Rule that owns Findings must not vanish silently: %v", err)
	}
	if deletion.Findings != 1 {
		t.Fatalf("the refusal must say how much history is at stake: %+v", deletion)
	}

	purged, err := store.DeleteRule(ctx, rule.DeleteRequest{
		ID: "probe-rule", PurgeFindings: true,
	})
	if err != nil {
		t.Fatalf("explicit purge: %v", err)
	}
	if purged.Findings != 1 || !purged.Applied {
		t.Fatalf("the purge must report what it discarded: %+v", purged)
	}
	if records, _ := findings.ListFindings(ctx, finding.Query{
		RuleID: "probe-rule", IncludeSuppressed: true, Limit: 10,
	}); len(records) != 0 {
		t.Fatalf("the Findings survived the purge: %+v", records)
	}
}

// A dry run has to be produced by the code that would do the work, or the plan
// an operator approves is not the plan that runs.
func TestDeleteRuleDryRunReportsWithoutRemoving(t *testing.T) {
	store := NewRuleStore()
	ctx := context.Background()
	if _, err := store.SaveRule(ctx, deletableRule(1)); err != nil {
		t.Fatalf("save rule: %v", err)
	}
	plan, err := store.DeleteRule(ctx, rule.DeleteRequest{ID: "probe-rule", DryRun: true})
	if err != nil {
		t.Fatalf("dry run: %v", err)
	}
	if plan.Applied || len(plan.Versions) != 1 {
		t.Fatalf("a dry run must describe one version and change nothing: %+v", plan)
	}
	if _, found, _ := store.GetRule(ctx, "probe-rule"); !found {
		t.Fatal("the dry run deleted the Rule it was only supposed to describe")
	}
}

func TestDeleteRuleReportsAMissingRule(t *testing.T) {
	store := NewRuleStore()
	if _, err := store.DeleteRule(context.Background(), rule.DeleteRequest{
		ID: "never-existed",
	}); !errors.Is(err, ports.ErrRuleNotFound) {
		t.Fatalf("deleting nothing must not read as success: %v", err)
	}
}
