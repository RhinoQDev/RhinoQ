# Contributing

RhinoQ accepts contributions through pull requests. The project is under active
development, so the public API, migrations and protocol still change. Open an
issue to agree on the direction before starting a large change.

Contributions are accepted under [Apache-2.0](./LICENSE), as section 5 of the
license provides. There is no separate CLA to sign.

## Before opening a pull request

1. Read `AGENTS.md`, `ARCHITECTURE.md` and `.ai/DEFINITION_OF_DONE.md`.
2. Write a task with acceptance criteria.
3. Keep the change small and inside one layer.
4. Run `make check`. Do **not** substitute a bare `go test ./...`: the
   PostgreSQL engine harness is a separate module under `tests/postgres`, and
   `./...` stops at the main module even under the workspace. `make test` names
   both, so a green run means both.
5. Run `make db-up test-postgres` when the change touches SQL, the store or the
   lease/fencing path. Without a database those tests skip and say so, which is
   not the same as passing.
6. Run `npm --prefix sdks/node test` if the change touches the Node SDK.
7. Update the docs and changelog if public behaviour changes.

## Review rules

- Nothing merges while CI is failing.
- Nothing merges that contains a secret or a credential.
- The domain, application and ports boundaries are not bypassed.
- A benchmark claim without its script, hardware and workload is not accepted.
- A migration needs expand → migrate → contract and a rollback plan.
- A new dependency must be Apache-2.0 compatible; GPL and AGPL are not accepted.

## Reporting a security vulnerability

Do not open a public issue. See [`SECURITY.md`](./SECURITY.md).
