package unit

import (
	"strings"
	"testing"

	"github.com/rhinoq/rhinoq/internal/infrastructure/migrations"
)

func TestMigrationCatalogIsContiguousAndChecksummed(t *testing.T) {
	catalog, err := migrations.Catalog()
	if err != nil {
		t.Fatal(err)
	}
	if len(catalog) < 7 {
		t.Fatalf("expected the current migration catalog, got %d entries", len(catalog))
	}
	for index, definition := range catalog {
		if definition.Version != index+1 || len(definition.Checksum) != 64 ||
			strings.TrimSpace(definition.SQL) == "" {
			t.Fatalf("invalid migration definition: %+v", definition)
		}
	}
}

func TestMigrationPlanContainsOnlyPendingSQL(t *testing.T) {
	catalog, err := migrations.Catalog()
	if err != nil {
		t.Fatal(err)
	}
	statuses := make([]migrations.Status, 0, len(catalog))
	for index, definition := range catalog {
		state := migrations.Pending
		if index == 0 {
			state = migrations.Applied
		}
		statuses = append(statuses, migrations.Status{
			Definition: definition, State: state,
		})
	}
	plan := migrations.SQLPlan(statuses)
	if strings.Contains(plan, catalog[0].Name) ||
		!strings.Contains(plan, catalog[1].Name) {
		t.Fatalf("plan must include only pending migrations:\n%s", plan)
	}
}
