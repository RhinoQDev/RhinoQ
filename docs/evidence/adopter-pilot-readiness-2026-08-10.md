# Adopter pilot readiness — 2026-08-10

This is a blocker audit, not external-adopter evidence and not a production
code-reduction claim.

## Repositories inspected

- `testrhinoa/api-mkt-video-scraper` contains an uncommitted A/B evaluation
  fixture under `rhinoq-eval/`. Its RhinoQ arm pins beta.9 and compares two
  purpose-built implementations. It has no committed before/after integration
  refs, so `scripts/code-reduction.sh` cannot produce a reproducible adopter
  delta from it.
- `scrapp-video` has no RhinoQ integration commit or RhinoQ branch. It cannot
  be treated as an `after` state.

The existing A/B fixture remains a local benchmark. Calling it a beta.10
adopter pilot would misstate both the version and the provenance of the code.

## Beta.10 controlled fixture

RhinoQ now contains a separate reproducible fixture with two real commits. It
is useful for validating the beta.10 package and integration surface, but it is
not a consenting adopter and does not close the external-adopter gate:

- before: `9095ce6e3ee9a2233728b5489403374619093c5c`
- after: `225f59400bf45ede7a437b7a0b134d9dadce896e`
- [fixture instructions](./adopter-pilot-beta10/README.md)
- [measured report](./adopter-pilot-beta10/code-reduction-partner-beta10-fixture-2026-08-11.md)

The fixture removes 36 net application-source lines but adds PostgreSQL to an
in-memory baseline. Its falsification result is therefore **not proven**, and
the report must not be used as an adopter savings claim. The old beta.9
fixture was not used to produce these numbers.

## Measurement required for the next run

Freeze two commits in the adopter's repository and run:

```bash
./scripts/code-reduction.sh \
  --repo /path/to/adopter \
  --before <commit-before-rhinoq> \
  --after <commit-after-rhinoq> \
  --partner A
```

The review must then fill the operational counts that a diff cannot infer:

| Measure | Before | After | Removed |
|---|---:|---:|---:|
| application source lines | not measured | not measured | not measured |
| task/status/progress/result routes | not measured | not measured | not measured |
| deployable processes | not measured | not measured | not measured |
| datastores | not measured | not measured | not measured |
| credential classes | not measured | not measured | not measured |

The pilot passes only if business handlers remain intact and durable Task
plumbing becomes materially smaller without adding a process, datastore or
credential burden that outweighs the deletion. A screenshot or a green demo
alone does not pass this gate.
