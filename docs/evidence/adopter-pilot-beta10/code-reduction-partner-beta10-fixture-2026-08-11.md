# Code reduction — controlled beta.10 fixture

Measured 2026-08-11 from the RhinoQ repository by comparing the two committed
refs below. This is a synthetic controlled pilot, not a design-partner result.

```text
repository: C:\Users\MKT\Desktop\rhinoq
before: 9095ce6e3ee9a2233728b5489403374619093c5c
after:  225f59400bf45ede7a437b7a0b134d9dadce896e
```

The measurement follows `scripts/code-reduction.sh` semantics. On Windows the
repository does not have a Bash distribution, so the same `git diff --numstat`
and exclusion rules were run with PowerShell.

## Lines

| Measure | Added | Removed | Net |
|---|---:|---:|---:|
| Whole fixture tree | 261 | 102 | +159 |
| Application source, excluding tests and lockfiles | 39 | 75 | -36 |

Files changed: 6. Files deleted outright: 0.

The fixture removes 36 net application-source lines. The whole tree grows
because the beta.10 package lockfile and integration test are part of the
reproducible setup.

## Route and operational accounting

These numbers describe this fixture only; they are not an adopter claim.

| Measure | Before | After | Interpretation |
|---|---:|---:|---|
| Application-owned route registrations | 4 | 1 mount | RhinoQ owns the Task surface after integration |
| Deployable processes | 1 | 1 | no new process in this fixture |
| Datastores to operate | 0 persistent | 1 PostgreSQL | the after state adds durable storage |
| Credential classes | 0 measured | 0 measured | host-owned owner/tenant headers are test inputs, not credentials |

## Falsification result

| Half | Result |
|---|---|
| business handler remains intact | pass for this fixture |
| materially less durable task plumbing without offsetting burden | not proven; the baseline had no persistent datastore |

This fixture is therefore a valid beta.10 before/after smoke test, but it does
not close the real-adopter gate and must not be used to advertise code,
route or process reduction. The next valid evidence must come from a consenting
existing application with two commits made in that application's repository.
