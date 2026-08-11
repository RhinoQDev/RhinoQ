# RhinoQ beta.10 pilot fixture

This is a reproducible controlled fixture, not a named adopter and not proof
of production code reduction. It exists because the old beta.9 evaluation was
not a valid before/after repository and must not be reused for a beta.10 claim.

The fixture is the RhinoQ repository at two real commits:

- before: `9095ce6e3ee9a2233728b5489403374619093c5c`
- after: `225f59400bf45ede7a437b7a0b134d9dadce896e`

The before commit contains a hand-written in-memory task service and four
application routes. The after commit preserves the import business entry point
but delegates task state and the owner HTTP surface to `@rhinoq/node` beta.10
and PostgreSQL. The fixture uses the workspace SDK through a local file
dependency so its source and version are inspectable.

## Reproduce

From `docs/evidence/adopter-pilot-beta10/repository`:

```powershell
npm install
$env:RHINOQ_PILOT_DATABASE_URL = 'postgres://rhinoq:rhinoq@localhost:55432/rhinoq?sslmode=disable'
npm run test:pilot
```

The PostgreSQL container from `tests/postgres/docker-compose.yml` must be
running first. The test creates and removes only the `rhinoq_task` schema.

## Interpretation

The diff is useful as a packaging/integration smoke test: the fixture removes
36 net application source lines and changes four application-owned route
registrations into one RhinoQ mount. It is not an adopter result because the
baseline is deliberately in-memory while the after state adds PostgreSQL.
The operational burden therefore does not pass the real-adopter falsification
criterion. A production claim still requires a consenting external repository
with its own before/after commits and partner-filled process, datastore and
credential counts.
