# Adopter pilot readiness — 2026-08-10

This is a blocker audit, not adopter evidence and not a code-reduction claim.

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
