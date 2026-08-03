# Security policy

## Status

RhinoQ is under active development and has no production-ready release yet.
No version currently receives long-term security support; security fixes land
on `main`. The latest audit and open release blockers are tracked in
[`docs/security-audit-2026-07-29.md`](./docs/security-audit-2026-07-29.md).

Never put secrets, access tokens, refresh tokens, production payloads or
customer information in the repository, an issue, a log or a commit.

## Reporting a vulnerability

Do not open a public issue for a security vulnerability. Use
[GitHub private vulnerability reporting](https://github.com/madebyduy/RhinoQ/security/advisories/new)
and include the affected version/commit, reproduction conditions, impact and
redacted logs.

Do not send real credentials. If a credential appears in a chat, log or commit,
revoke and rotate it immediately; deleting it from a file does not invalidate
the old credential.

## Integrity Rules

Rules contain developer-written SQL. The Explain gate checks result shape,
timeout, limit and plan cost; it is **not a SQL sandbox**. Production Rules
must run with a dedicated restricted PostgreSQL read-only role, and that role
must not be granted functions or extensions with filesystem or network side
effects. See [`docs/rules.md`](./docs/rules.md) and
[`docs/postgres.md`](./docs/postgres.md).

## Security baseline

- The main branch is protected; do not push directly to `main`.
- Every change requires a pull request and passing CI.
- Secret and dependency scanning run in CI.
- Releases use signed tags or equivalent provenance.
- Redact payloads and logs before persistence.
- Repair and operator actions require an audit trail.
