.PHONY: fmt test vet check clean db-up db-down test-postgres

fmt:
	gofmt -w cmd internal tests pkg examples

test:
	go test ./...

vet:
	go vet ./...

check: fmt test vet

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
