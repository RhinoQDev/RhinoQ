package main

import (
	"database/sql"
	"testing"
)

func TestOfficialGatewayRegistersPGX(t *testing.T) {
	for _, driver := range sql.Drivers() {
		if driver == "pgx" {
			return
		}
	}
	t.Fatalf("official Gateway must register pgx; available drivers: %v", sql.Drivers())
}
