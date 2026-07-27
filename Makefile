.PHONY: fmt test vet check clean

fmt:
	gofmt -w cmd internal tests

test:
	go test ./...

vet:
	go vet ./...

check: fmt test vet

clean:
	go clean
