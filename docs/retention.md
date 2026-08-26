# Evidence retention and partitioning

RhinoQ writes two kinds of row: state an operator still acts on, and evidence
that something was looked at. The second kind grows with your traffic and never
stops, so it needs a decision.

## The table this is really about

`rhinoq_subject_outcomes` holds the canonical state for one Rule version and one
business subject. Every scan writes one row per observed subject.

That is a row per subject, per Rule, per Rule version. Measured against a
production-shaped schema with 40 000 subjects and a single Rule, it was 10 MB
next to a 13 MB business table. Five Rules over three versions each is fifteen
times that, and nothing prunes it on its own.

`rhinoq_finding_events` is the second: append-only lifecycle history, one row per
observation or operator decision, kept for Findings that were resolved long ago.

Everything else — Findings, repairs, ProviderOperations and their evidence — is
either small or the record you would need during a dispute. Do not prune it on a
schedule.

## Prune

```bash
rhinoq retention prune --older-than 90d           # preview; changes nothing
rhinoq retention prune --older-than 90d --apply
```

Preview is the default, exactly like `rhinoq rules delete`. The plan names each
table and the number of rows it would remove.

| Table | What is removed |
|---|---|
| `rhinoq_subject_outcomes` | passing observations not seen since the cutoff |
| `rhinoq_finding_events` | lifecycle history of Findings already resolved before the cutoff |
| `rhinoq_notification_deliveries` | settled delivery ledger entries older than the cutoff |

Never removed at any age: an open Finding, a pending delivery, a repair, a
ProviderOperation or its request evidence.

Only `passed` outcomes are prunable. A subject whose last observation was
`violated` or `unknown` keeps its state, because that state is what a Rule
compares against on the next run.

`--older-than` accepts `90d`, `720h` or any Go duration, and refuses anything
under 24h: the one retention mistake that cannot be undone is deleting evidence
of an incident that is still open.

### Why it deletes in batches

Every statement is bounded by `--batch` (default 5000) and runs in its own
transaction. An unbounded `DELETE` against the table a running scan is writing to
holds locks for the length of the delete and generates the vacuum pressure it was
supposed to relieve. That is how a retention job becomes the outage it was added
to prevent.

A run that hits its context deadline is a normal outcome. It reports what it
removed and the next run resumes.

### Space returns to PostgreSQL, not to the disk

A delete marks rows dead; PostgreSQL reuses that space for new rows. If a
partition or table has to shrink on the filesystem, schedule `VACUUM FULL` in a
maintenance window — it takes an exclusive lock.

## Scheduling it

`rhinoq retention prune` is a single bounded process, not a distributed
scheduler. Run it from whatever already runs your periodic work — cron, a
Kubernetes CronJob, your own scheduler — on one node. Two concurrent prunes are
safe (each batch is its own transaction and deletes disjoint rows or none), but
they gain nothing.

## Task files and Task records

Task artifacts use their own expiry and cleanup lease. Applications with a
deletable artifact provider can schedule the already-wired
`app.artifactRetention` service:

```ts
const expired = await app.artifactRetention.preview(25);
// Log/review the bounded preview under the application's retention policy.
const result = await app.artifactRetention.sweep({ delete: true, limit: 25 });
```

The sweep claims expired rows with a lease, deletes provider content before
metadata, advances the Task version after metadata removal and records failed
cleanup for inspection. Storage references remain server-side throughout.

RhinoQ intentionally does not auto-delete terminal Task, execution, effect,
verification or checkpoint records. Those records can be required to decide
whether an external action happened, and the repository has no evidence from
which to guess an adopter's legal/dispute window. Export required evidence and
define that wider policy before adding application-specific Task deletion.

## Choosing the window

RhinoQ does not choose a legal retention period for the adopter. The window has
to exceed the longest provider dispute, audit and repair window you are subject
to. A payments team is usually bounded by chargeback windows, which are longer
than most teams' first guess.

## Partitioning

Start monthly range partitioning when an evidence table's index no longer fits
the deployment's memory budget, or when routine retention deletes create vacuum
pressure. This is an observed threshold, not a fixed row count.

With partitioning in place, detach and drop one partition at a time. Dropping a
partition is a metadata operation; deleting the same rows is not.

## Before you prune anything

Export terminal Execution, attempt, effect, outcome, notification and audit
evidence you are required to keep. Preserve correlation IDs and hashes — they are
what lets an exported record be tied back to the operation it describes.
