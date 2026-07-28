// The PostgreSQL integration harness is a separate module on purpose: it needs
// a real database harness. The embedded library accepts database/sql so
// applications still own their pool and driver; the official root CLI bundles
// pgx separately.
module github.com/rhinoq/rhinoq/tests/postgres

go 1.22

replace github.com/rhinoq/rhinoq => ../..

require (
	github.com/jackc/pgx/v5 v5.7.2
	github.com/rhinoq/rhinoq v0.0.0-00010101000000-000000000000
)

require (
	github.com/jackc/pgpassfile v1.0.0 // indirect
	github.com/jackc/pgservicefile v0.0.0-20240606120523-5a60cdf6a761 // indirect
	github.com/jackc/puddle/v2 v2.2.2 // indirect
	golang.org/x/crypto v0.31.0 // indirect
	golang.org/x/sync v0.10.0 // indirect
	golang.org/x/text v0.21.0 // indirect
)
