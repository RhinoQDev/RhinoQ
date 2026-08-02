# Measuring plumbing

> **Status: not measured.** No line of application code has been deleted and
> counted yet. Until that number exists, "materially less plumbing" is a
> hypothesis, and this repository must not print it as a claim.

`competitive-landscape.md` set the falsification criterion for the primary
workload itself:

> two user-visible tasks on an existing queue → RhinoQ must demonstrate:
> **no business-handler rewrite and materially less durable task plumbing**

| Half of the criterion | Result |
|---|---|
| no business-handler rewrite | **met** — the probe never touched the application's processors |
| materially less plumbing | **not met, not measured** — the second probe added ~330 lines and removed 0 |

The second probe predates `PostgresTaskClient`, the three-table Task profile and
the detector. Each of those was built to move this number. None of them has
been re-measured against a real application, and an argument that they should
help is not a measurement.

This document exists so that the measurement is specified before it is taken,
and so a favourable subset cannot be selected after the fact.

## What gets counted

Take the count on the commit **before** integration and on the commit **after**
the dead code is removed, in the same working tree.

| Dimension | Definition | Instrument |
|---|---|---|
| Lines of code | non-blank, non-comment lines in the application's own repository, excluding vendored code, lockfiles and generated output | `scripts/measure-plumbing.sh` |
| Processes | long-lived processes the deployment must supervise and restart | counted by hand from the compose/k8s manifests |
| Datastores | databases and caches whose availability the feature depends on | counted by hand from connection strings |
| Credentials | distinct secrets an operator must issue, rotate and store | counted by hand from the environment |

Three rules, because each of them is a way the number could be flattered:

1. **Both counts come from the same repository.** Code that moves from the
   application into RhinoQ's configuration has not disappeared; a Rule file is
   counted as added application code, not as removed plumbing.
2. **Deleted means deleted.** Code that is commented out, feature-flagged off or
   left unreferenced is still in the repository and still counts.
3. **Report the net, and report the gross both ways.** A change that removes 300
   lines and adds 280 is a net of 20, and printing only the 300 is the specific
   dishonesty this document is meant to prevent.

## Procedure

```bash
# 1. Baseline, on the application repository, before any RhinoQ code.
scripts/measure-plumbing.sh /path/to/app > before.json

# 2. Integrate. Wire the detector, then the Task client at the call sites.
#    Do not delete anything yet.

# 3. Delete what is now dead, and only what is now dead.

# 4. After.
scripts/measure-plumbing.sh /path/to/app > after.json
```

Record both files and the diff in `docs/evidence/`, together with the commit
SHAs on both sides. A number without the commits it came from is not evidence.

## The specific candidates in `api-mkt-video-scraper`

From [the integration report](./integration-bullmq-mkt-video-scraper.md). These
are **estimates of what may become deletable**, not results:

| Candidate | Size | Why it might go | Why it might not |
|---|---:|---|---|
| Redis `:results` hash in `bulk-download.processor.ts` | ~45 LOC | per-item outcome now lives on Execution (`resultRef`, `failureReason`, schema 017) | the 24h TTL behaviour has no RhinoQ equivalent |
| status assembly in `videos.controller.ts` | ~223 LOC | Task Summary carries aggregate counts and version | the endpoint's response shape is public API |
| per-item bookkeeping inside the SSE handlers | part of ~505 LOC | polling a versioned Summary replaces derived counting | the SSE endpoints themselves stay; only the bookkeeping inside them is in scope |
| `search_jobs` table and its writes | not sized | Task replaces the hand-rolled task table | it carries columns unrelated to task state |

The honest reading of that table is that the recoverable amount is uncertain and
smaller than the gross line counts suggest.

## What blocks the measurement today

`api-mkt-video-scraper` is a separate, private repository. This one cannot
produce the number on its own — the harness is here, the subject is not. The
measurement needs a working tree of that application and the commits on both
sides.

## What must not be claimed until then

- Not that the application gets smaller.
- Not Inngest's or Trigger.dev's code-reduction numbers. They own the runtime —
  queue, worker bootstrap, retry config and handler shape all disappear. RhinoQ
  deliberately keeps the application's runtime, so its ceiling is lower by
  design. That is the trade, not a failure, and the number cannot be borrowed.
- Not that the detector reduces code at all. The detector's claim is a different
  one and it is already demonstrated: a first Finding costs one command and one
  read-only role. It adds a Rule file; it deletes nothing.
