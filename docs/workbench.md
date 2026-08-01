# RhinoQ Workbench

RhinoQ Workbench is the local developer interface for inspecting background
work and its business evidence. It is not a hosted admin product and it does
not introduce another control-plane service.

## Open it

With `RHINOQ_DATABASE_URL` configured and migrations applied:

```bash
rhinoq workbench
```

The command binds an HTTP server to `127.0.0.1:8787` and opens the system
browser. It never listens on a public interface.

Useful development options:

```bash
# See the interface without PostgreSQL
rhinoq workbench --demo

# Keep it in the terminal or use a remote port forward
rhinoq workbench --no-open

# Select another loopback port or start with one queue
rhinoq workbench --port 8790
rhinoq workbench --queue generate-report
```

During repository evaluation, the same command can run from source:

```bash
go run ./cmd/rhinoq workbench --demo
```

Prebuilt CLI binaries have not been released yet. Node.js users will use the
same Go CLI binary once distribution is available; the Workbench does not
require a Node.js frontend server.

See [cli.md](./cli.md) for every Workbench flag, source-install command, exit
code and the boundary between browser reads and explicit CLI writes.

## What developers see

- **Execution worktable:** a dense, sticky-header table for job state, queue,
  correlation, stage, attempts, priority and age.
- **Flow Lens:** COMMIT, RUN, VERIFY and RECOVER stay visible as separate
  stages instead of collapsing everything into “success” or “failure”.
- **Evidence Rail:** selecting a job shows append-only attempt events, declared
  effects, outcome observations and decision audit next to the row.
- **Needs Attention:** execution failures, uncertain effects, outcome
  mismatches and persistent Findings share one bounded inbox.
- **Integrity views:** Findings and Rules are available without switching to a
  different product.
- **Developer ergonomics:** search, queue/state/stage lenses, configurable
  columns, compact/comfortable density, light/dark themes, `J`/`K` navigation,
  `/` search and `Ctrl/Cmd+K` commands.

The defining visual contract is:

```text
request accepted  ≠  effect confirmed  ≠  outcome achieved
```

It is visible in the Evidence Rail because it is also a correctness boundary in
the engine.

## Visual language: Obsidian Ledger

The default dark theme is intentionally not a generic â€œneon queue dashboardâ€.
It uses a low-glare obsidian surface, warm mineral brass only for the active
lens and counts, and verdigris only for confirmed evidence. The **Proof Path**
is a single horizontal line through COMMIT, RUN, VERIFY and RECOVER; it gives
RhinoQ a recognizable navigation motif without adding a card for every number.

Typography separates reading modes: an editorial serif for the question being
investigated, a technical mono face for state/IDs, and a restrained UI face for
controls. The result is dense enough for operators but leaves the hierarchy
clear at a glance. This is presentation only: theme does not change state,
permissions or evidence semantics.

## Safety and privacy

Workbench is read-only by default. `--actions` explicitly enables only subject
recheck and the registered safe-repair workflow:

- it exposes no replay, pause, arbitrary SQL or unregistered mutation;
- repair requires proposal, dry-run, different approver, reason, fresh
  precondition, application callback and automatic verification;
- list and evidence reads are bounded;
- job payloads are not part of the Workbench DTOs;
- database credentials are never sent to the browser or printed in the source
  label;
- API responses use `Cache-Control: no-store`;
- browser requests must be same-origin and the HTTP Host must resolve to an
  explicit loopback name/address, which closes the common DNS-rebinding path;
- CSP, frame denial, content-type protection and a restrictive permissions
  policy are set on every response.

Every action goes through an application use case; Workbench never calls a
store directly. Without `RHINOQ_REPAIR_CALLBACKS_JSON`, no business repair
handler is registered and preview/execute fail closed.

## Architecture

```mermaid
flowchart LR
  Dev["Developer browser"]
  HTTP["Embedded Workbench HTTP\n127.0.0.1 only"]
  Reader["Read-only Reader contract"]
  Facade["Public RhinoQ facade"]
  App["Application services"]
  Ports["Inspection ports"]
  PG[("PostgreSQL")]

  Dev -->|bounded JSON| HTTP
  HTTP --> Reader
  Reader --> Facade
  Facade --> App
  App --> Ports
  Ports --> PG
```

The static HTML, CSS and JavaScript are embedded into the Go binary under
`internal/interfaces/workbench/static`. There is no React runtime, package
manager, external font, icon library or telemetry script. An automated test
holds the embedded frontend below a 160 KiB uncompressed budget; the current
three assets are below 100 KiB.

`cmd/rhinoq` is the composition root. The HTTP package cannot import a
PostgreSQL adapter. Live reads are translated from the public `rhinoq.Client`;
demo reads implement the same Reader contract. This boundary allows a future
read replica or read model without changing the browser protocol.

## Interaction research, not visual copying

The interface combines proven interaction ideas while keeping RhinoQ's own
information architecture, vocabulary, code and assets:

- [Inngest](https://github.com/inngest/inngest) and
  [bull-board](https://github.com/felixmosh/bull-board) demonstrate the value of
  a local browser view near the worker.
- [Temporal UI](https://github.com/temporalio/ui) and its
  [configurable workflow table discussion](https://github.com/temporalio/ui/issues/2577)
  reinforce dense filtering and user-controlled columns.
- [Supabase Studio](https://github.com/supabase/supabase) demonstrates a
  developer-first database surface with command navigation and explicit
  operation review.
- [Grafana](https://github.com/grafana/grafana) demonstrates context-preserving
  inspection rather than forcing developers through disconnected pages.
- [Sentry](https://github.com/getsentry/sentry) demonstrates triage-oriented
  issue streams and regression visibility.
- [Trigger.dev](https://github.com/triggerdotdev/trigger.dev) demonstrates
  searchable run views and observable retry history.
- The [Anthropic frontend-design skill](https://github.com/anthropics/claude-code/blob/main/plugins/frontend-design/skills/frontend-design/SKILL.md),
  [Emil Kowalski's design-engineering skill](https://github.com/emilkowalski/skill/blob/main/skills/emil-design-eng/SKILL.md)
  and [OpenAI's frontend-skill](https://github.com/openai/skills/blob/main/skills/.curated/frontend-skill/SKILL.md)
  informed the restraint rules: a deliberate art direction, no copied product
  UI, clear type hierarchy and motion only where it clarifies state.

RhinoQ does not copy their layout, code, visual assets or product categories.
Its distinct primitives are the four-stage Flow Lens, the evidence separation,
the business-integrity inbox and the guarded decision audit.

## Current boundary

Implemented now:

- local demo and live PostgreSQL modes;
- jobs, Needs Attention, Findings and Rules;
- per-job attempts, effects, outcomes and replay audit;
- responsive table and Evidence Rail;
- keyboard, theme, density and column preferences;
- security headers and payload-free read models;
- a business-subject investigation view.

## Subject investigation

Selecting a Finding opens the subject it is about, not the job that produced it.
The view answers one question — *what happened to `report_3912`* — by merging
into a single time-ordered narrative:

- a verdict: clean, drift, or unknown;
- every execution that touched the subject, whether RhinoQ ran it or BullMQ,
  Temporal, cron or an application did;
- Effect Ledger entries with their confirmation state;
- observations RhinoQ made and decisions people took, told apart by whether an
  actor is recorded.

`GET /api/v1/subjects/{type}/{id}` serves it. Type and id are separate path
segments because a subject id may itself contain a slash.

Unknown is its own verdict rather than a shade of clean: an effect whose
execution died has an unknown result, and reporting that as clean would claim
more than RhinoQ knows.

Not implemented:

- write actions in the browser;
- business repair — the page reports what happened; it cannot fix it;
- tenant-aware remote hosting or authentication;
- streaming updates and large-history virtualization;
- packaged CLI distribution.

Those omissions are explicit. Workbench v0 makes current evidence easier to use;
it does not pretend the remaining adoption and correlation work is complete.
