# syntax=docker/dockerfile:1.7
FROM golang:1.26.5-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
ARG VERSION=0.1.0-dev
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w -X main.version=${VERSION}" -o /out/rhinoq ./cmd/rhinoq
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/rhinoq-agent ./cmd/rhinoq-agent

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /out/rhinoq /usr/local/bin/rhinoq
COPY --from=build /out/rhinoq-agent /usr/local/bin/rhinoq-agent
USER nonroot:nonroot
EXPOSE 8080
# The CLI is the entrypoint because `detect` is the front door: an evaluator
# with a read-only role should reach a first Finding with one `docker run` and
# no flags to look up. The Gateway is still in the image; run it with
# `--entrypoint /usr/local/bin/rhinoq-agent`.
ENTRYPOINT ["/usr/local/bin/rhinoq"]
CMD ["help"]
