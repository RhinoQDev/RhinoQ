# The adoption gap

> Written 2026-07-29, after the second adopter probe against
> `api-mkt-video-scraper` and the contract work in `74b5d94`.
> Updated 2026-08-02: items 4 and 7 are done, item 5 is blocked on a manual npm
> account action, and the on-ramp argument below produced
> [ADR-0022](../.ai/DECISIONS.md) and `rhinoq detect`. Items 1–3 remain
> unmeasured. See [Measuring plumbing](./measuring-plumbing.md).
>
> [`adoption-review.md`](adoption-review.md) assesses what exists.
> [`competitive-landscape.md`](competitive-landscape.md) states the product
> hypothesis. This document is narrower and more uncomfortable: it argues that
> the contract is no longer what limits adoption, and lists what is.

## The finding

Two adopter probes have now run against a production BullMQ application that
was not written for this evaluation. Both reached the same shape of conclusion,
and the second one is worth stating plainly:

**The contract is good. The cost of getting to it is the problem.**

`competitive-landscape.md` sets its own falsification criterion for the primary
workload:

> two user-visible tasks on an existing queue → RhinoQ must demonstrate:
> **no business-handler rewrite and materially less durable task plumbing**

| Half of the criterion | Result |
|---|---|
| no business-handler rewrite | **met** — the application's processors were not touched |
| materially less plumbing | **not met** — 0 lines removed, ~330 added, plus a second datastore, a second process and a three-credential model |

`.ai/STATUS.md` independently scores **ADOPTION 1/4**, the lowest of every
tracked area, below DX at 8/10 and RUN at 11/11. The gap is already known
internally; this document is about acting on it.

## The structural asymmetry

A Node application could enqueue through RhinoQ **without running the Gateway**:
`PostgresProducer` executes on the application's own PostgreSQL pool and can
join its transaction.

At the time of the probe, a Node application could not manage **Tasks** without
the Gateway. The Go client could. The current `beta.7` candidate closes that
asymmetry with `PostgresTaskClient` and the isolated three-table Task profile.
The paragraph below remains the measured reason for that change, not a claim
that the new economics have already passed re-evaluation.

Previously, the runtime that is the target audience — BullMQ is a Node
ecosystem — was the one required to run a second process.

Three of the six costs listed under "Complexity RhinoQ adds" in the adopter
report exist only because of this asymmetry:

- a second process to build from Go source, health-check and restart;
- a second datastore (the Task tables are plain SQL and could live in the
  application's own database; the separate instance was a deployment choice,
  not a requirement);
- an operator credential distinct from the per-owner ones.

**The real competitor is not Temporal or Inngest. It is a `tasks` table plus
200 lines in the application's own repository.** RhinoQ has something that
table does not — monotonic progress, `too_late` cancellation, Execution
separated from Task, fenced writes, idempotent duplicates, per-item outcome —
and those are exactly the things a hand-rolled table gets wrong. But that only
wins if the price is close to the price of a table.

## What `74b5d94` changed

Before it, the honest answer to "can an adopter delete their task plumbing" was
*no, and structurally not*: a Task held one aggregate result reference, so a
fan-out could report `37/50` but not where item 37 landed or why item 38
failed. The application had to keep a parallel per-item store, and that store
kept every status endpoint and SSE handler alive.

`Execution` now carries `resultRef` and `failureReason` (schema 017). The
answer is now *not yet, for lack of evidence* — a different and much cheaper
kind of no.

What this does **not** prove: no application code has been deleted yet. The
estimates below are estimates.

## Ordered work

### P0 — these change the verdict

1. **Embedded Node Task client — implemented on `main`, remeasurement pending.**
   Peer of `PostgresProducer`: runs on the
   application's PostgreSQL pool, tables in the application's own database, no
   Gateway process, no operator token. This is the difference between a
   platform you install and a library you import, and for a Node/BullMQ team it
   is the whole decision. Everything else on this list is smaller.

   This is an architecture decision, not permission to port Task transition
   rules into TypeScript. A direct-SQL client that reimplements monotonic
   progress, cancellation outcomes and version fencing would create a second
   correctness authority and violate the current Go-authoritative boundary.
   The implementation must first choose and record one reusable authority
   (for example versioned database commands with cross-language parity, or a
   distributable embedded/local Go boundary) and prove it against the same
   adversarial contract suite.

   `PostgresTaskClient` now calls versioned `rhinoq_task.*` commands and the
   Task-only migration creates three isolated tables. This removes the Gateway
   from the candidate architecture; it does **not** change the adopter verdict
   until the same real application deletes the old Gateway/client plumbing and
   produces a new LOC/process/credential count.

2. **Delete code in a real application and count it. — still not measured.**
   Wire the module into the two call sites in `api-mkt-video-scraper`, then
   remove what becomes dead. Estimated reachable now that per-item outcome
   exists: the Redis `:results` hash, most of the 223-line status assembly, and
   the per-item bookkeeping inside the 505 lines of SSE handlers. Until a real
   number replaces that estimate, "materially less plumbing" is a promise, not
   a claim.

   What changed on 2026-08-02 is only that the measurement is now specified
   instead of intended: [Measuring plumbing](./measuring-plumbing.md) fixes what
   counts, and `scripts/measure-plumbing.sh` takes the count. The subject
   application is a separate private repository, so this repository cannot
   produce the number by itself.

3. **A frontend, however small.** Two tabs, one reload, one Cancel pressed as
   the job finishes. The strongest value — `entityVersion`, monotonic progress,
   `too_late`, `cancel_requested` — is concentrated in the browser, and the
   evaluation had no browser at all. This is the least-tested and most-load-
   bearing claim in the product.

### P0.5 — the on-ramp itself, added 2026-08-02

The three items above all assume the adopter has already decided to integrate.
The probes suggest the decision happens earlier and is made by someone else: the
person who owns the database, whose question is not "is the contract good" but
"what are you asking permission to write". Every previous entry point answered
that badly — `npm install` plus 22 migrations plus a second process.

**Done: `rhinoq detect`** ([ADR-0022](../.ai/DECISIONS.md)). One `docker run`, a
role with `CONNECT` and `SELECT`, no migration against the application's schema,
no RhinoQ table inside it, and by default no write anywhere at all. Captured
run and the proof that the role cannot write:
[evidence](./evidence/detector-first-finding-2026-08-02.md).

This does not close items 1–3. It changes who has to say yes before they start.

### P1 — remove friction, do not change the verdict

4. **Publish `rhinoq-agent` as a binary and an image. — done.** Every tag now
   attaches signed Linux/macOS/Windows binaries with checksums, sigstore bundles
   and SBOMs, and pushes a container image. The image's entrypoint is now the
   CLI, so `docker run … detect` is the first command an evaluator runs. No Go
   toolchain is on any documented path.
5. **Publish `0.1.0-beta.7` and move the `latest` dist-tag. — blocked, not
   done.** The GitHub release exists; npm does not. The registry still serves
   `0.1.0-beta.2` on `next` and `0.1.0-beta.1` on `latest` while this repository
   is at `0.1.0-beta.7`, so `main` and the published package share a version
   number but not an API. The workflow is already configured for trusted
   publishing; what is missing is linking the package to this repository and
   workflow in the npm account UI, which no automation here can do. Until then
   every install instruction points at the release tarball.
6. **Cancellation needs hands, not just a state machine.** `cancel_requested`,
   `too_late` and `cannot_cancel_safely` are modelled and tested, but nothing
   stops a BullMQ job. The adopter still writes the removal and the checkpoint
   polling themselves.
7. **Decide about realtime. — done.** Polling is the decision, recorded as
   [ADR-0023](../.ai/DECISIONS.md) with the one measurement that would reopen
   it. "Realtime later" has been removed from the roadmap and the docs.

### P2 — do not start these yet

Organization/RBAC authorization, the multi-node notification scheduler,
deployment-shaped chaos evidence and further benchmarks. None of them is what
stops a team adopting RhinoQ today, and each adds surface to a product whose
problem is that it already asks for too much before first value.

ProviderOperation belongs here too, for a different reason: it is implemented
and tested, but from Node it needs the Gateway process, and that is exactly the
cost the on-ramp work was meant to remove. It is documented as phase 2
([ADR-0024](../.ai/DECISIONS.md)) rather than presented as the core contract.

## How the test suite has to change

Every one of the five contract gaps found by the probes lived in code that had
passing tests. Two of them survived for a specific, repeatable reason:

- nothing ever sent a **duplicate** request, so identical progress writes
  advanced `entityVersion` for months;
- nothing ever exercised the **default** path, so `terminalProjection`
  defaulted to the value that silently corrupts a fan-out.

The suite tests what the author intended. The probes tested what an adopter
does. Every gap lived in that gap.

Concretely: keep adding adversarial cases rather than confirming ones — send it
twice, send it stale, send it out of order, omit the option, pass the obvious
wrong value. The probe reports should become permanent tests instead of being
read and filed.

## What not to claim

- **Not Inngest's or Trigger.dev's code-reduction numbers.** They reduce more
  because they own the runtime: the queue, worker bootstrap, retry config and
  handler shape all go away. RhinoQ deliberately keeps the application's
  runtime, so its ceiling is lower by design. That is the trade, not a failure
  — but the number cannot be borrowed.
- **Not "the application gets smaller"**, until item 2 above produces a
  measured figure.
- **Not exactly-once external execution.** The Effect Ledger is one explicit
  evidence model, as `competitive-landscape.md` already says.

## The one-sentence version

The contract is worth adopting; the on-ramp is what is burying it, and the
embedded Node client is the shortest path from one to the other.
