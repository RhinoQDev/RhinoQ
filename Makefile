.PHONY: fmt test vet check clean db-up db-down test-postgres

fmt:
	gofmt -w cmd internal tests pkg examples

test:
	go test ./...

vet:
	go vet ./...

check: fmt test vet

# The PostgreSQL harness is a separate module: it needs a driver, and the
# engine stays dependency-free.
db-up:
	docker compose -f tests/postgres/docker-compose.yml up -d --wait

db-down:
	docker compose -f tests/postgres/docker-compose.yml down -v

test-postgres:
	cd tests/postgres && RHINOQ_TEST_DATABASE_URL=postgres://rhinoq:rhinoq@localhost:55432/rhinoq?sslmode=disable go test ./... -count=1

clean:
	go clean
