.PHONY: fmt test vet test-node benchmark benchmark-node benchmark-go check clean db-up db-down test-postgres

fmt:
	gofmt -w cmd internal tests pkg examples

# go.work makes the nested module reachable from the root, but `./...` still
# stops at the main module. Naming it here is what keeps `make test` from
# reporting PASS over fourteen untouched engine contracts. Without
# RHINOQ_TEST_DATABASE_URL those tests skip and say so; `make db-up test` runs
# them for real. tests/unit/workspace_test.go fails if a new module is added
# without being listed here.
test:
	go test ./... ./tests/postgres/...

vet:
	go vet ./... ./tests/postgres/...

test-node:
	npm --prefix sdks/node test

benchmark: benchmark-node benchmark-go

benchmark-node:
	npm --prefix sdks/node run benchmark

benchmark-go:
	go test ./tests/benchmarks -run '^$$' -bench . -benchmem -count=5

check: fmt test vet test-node

# The PostgreSQL harness remains a separate module. The embedded library accepts
# database/sql; the root module bundles pgx only for the official CLI.
db-up:
	docker compose -f tests/postgres/docker-compose.yml up -d --wait

db-down:
	docker compose -f tests/postgres/docker-compose.yml down -v

test-postgres:
	cd tests/postgres && RHINOQ_TEST_DATABASE_URL=postgres://rhinoq:rhinoq@localhost:55432/rhinoq?sslmode=disable go test ./... -count=1

clean:
	go clean
