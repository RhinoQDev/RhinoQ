package migrations

import (
	"errors"
	"testing"
)

func TestValidateAppliedRefusesSchemaAhead(t *testing.T) {
	catalog := testCatalog()
	applied := map[int]appliedMigration{
		1: {name: catalog[0].Name, checksum: catalog[0].Checksum},
		3: {name: "003_future.sql", checksum: "future"},
	}
	if err := validateApplied(catalog, applied); !errors.Is(err, ErrSchemaAhead) {
		t.Fatalf("expected schema-ahead error, got %v", err)
	}
}

func TestValidateAppliedRefusesHistoryGap(t *testing.T) {
	catalog := testCatalog()
	applied := map[int]appliedMigration{
		2: {name: catalog[1].Name, checksum: catalog[1].Checksum},
	}
	if err := validateApplied(catalog, applied); !errors.Is(err, ErrMigrationHistory) {
		t.Fatalf("expected migration-history error, got %v", err)
	}
}

func TestValidateAppliedRefusesChecksumDrift(t *testing.T) {
	catalog := testCatalog()
	applied := map[int]appliedMigration{
		1: {name: catalog[0].Name, checksum: "changed"},
	}
	if err := validateApplied(catalog, applied); !errors.Is(err, ErrChecksumDrift) {
		t.Fatalf("expected checksum-drift error, got %v", err)
	}
}

func testCatalog() []Definition {
	return []Definition{
		{Version: 1, Name: "001_initial.sql", Checksum: "one"},
		{Version: 2, Name: "002_next.sql", Checksum: "two"},
	}
}
