# RhinoQ CLI reference

> Node application setup: `npx rhinoq setup` is the preview-first golden path
> that composes the Node SDK's existing init, adopt, doctor and eval commands.
> Run it once without `--apply`, review the plan, then apply. See
> [one-command setup](./setup.md). The Go CLI described below remains the
> authoritative full-runtime operations CLI.

The RhinoQ CLI prepares the PostgreSQL schema, validates a deployment, exposes
bounded operational reads, runs the Rule scheduler and opens the local
Workbench. This page documents every command implemented by the current
development preview.

The CLI is not a generic job producer and it is not a standalone Go worker:

- Go applications enqueue and run handlers through `pkg/rhinoq`.
- Node.js producers use `PostgresProducer`; Node.js handlers use
  `RhinoQWorker` through the optional HTTP Gateway.
- Any language can call `rhinoq.enqueue()` inside its own PostgreSQL
  transaction.
- Workbench is read-only by default. `--actions` enables only recheck and
  registered safe-repair application use cases.

For an existing Node repository, the read-only Integration Eraser preview is:

```bash
npx rhinoq adopt --scan
npx rhinoq adopt --scan --json
```

It reports bounded source evidence and never writes or deletes files. See the
[Integration Eraser guide](./integration-eraser.md).

The Node CLI also exposes the read-only Caddy-inspired composition surfaces:

```bash
npx rhinoq plan --from manifest.json --output .rhinoq/plan.json
npx rhinoq plan validate --from .rhinoq/plan.json
npx rhinoq plan diff --from .rhinoq/plan.json --against .rhinoq/plan.previous.json
npx rhinoq capabilities --json
npx rhinoq modules doctor --json
npx rhinoq build-profile --with processor/ffmpeg@1.0.0 --json
npx rhinoq explain task report.export --from .rhinoq/plan.json
```

These commands consume explicit JSON or the bounded built-in catalog. They do
not import arbitrary project source, install dependencies, mutate Task state or
start a Control Plane. A build profile is a composition proposal until exact
checksums, provenance and target-image smoke are attached.

## Run the preview CLI

Install the CLI into Go's binary directory:

```bash
go install github.com/madebyduy/RhinoQ/cmd/rhinoq@latest
rhinoq version
```

From a repository checkout, `go install ./cmd/rhinoq` does the same.

No tag has been published yet, so prebuilt binaries are not downloadable. The
release pipeline that produces them for Linux, macOS and Windows is committed at
[`.goreleaser.yaml`](../.goreleaser.yaml); it runs on a `v*` tag push and
publishes a signed `checksums.txt`.

If the shell cannot find `rhinoq`, inspect the install locations:

```bash
go env GOBIN
go env GOPATH
```

When `GOBIN` is empty, Go uses the `bin` directory under `GOPATH`. Add it to
the current shell, or keep using `go run ./cmd/rhinoq`:

```bash
# Bash, zsh or WSL
export PATH="$(go env GOPATH)/bin:$PATH"
```

```powershell
# Windows PowerShell
$env:Path += ";$(go env GOPATH)\bin"
```

Or run one command directly from source:

```bash
go run ./cmd/rhinoq help
go run ./cmd/rhinoq workbench --demo
```

The latest verified tagged CLI prerelease is beta.17. Its intended installation
command is:

```bash
go install github.com/madebyduy/RhinoQ/cmd/rhinoq@v0.1.0-beta.17
```

The beta.17 release workflow completed, including signed checksums and prebuilt
binaries. Do not put `@latest` into production automation while RhinoQ remains
in prerelease; pin the exact tag above.

## Get help in the terminal

```bash
rhinoq help
rhinoq help migrate
rhinoq jobs --help
```

`rhinoq help` lists all command groups. `rhinoq help <command>` explains the
purpose, flags, write behavior and examples for that command.

Exit codes are stable across the current CLI:

| Code | Meaning |
|---:|---|
| `0` | command completed successfully |
| `1` | configuration, database or runtime operation failed |
| `2` | command or flags were invalid |

## Configure the shell

Most commands connect directly to PostgreSQL and require
`RHINOQ_DATABASE_URL`.

### Bash, zsh or WSL

```bash
export RHINOQ_DATABASE_URL='postgres://postgres:postgres@localhost:5432/app?sslmode=disable'
export RHINOQ_WORKER_NAME='reports-worker-1'
```

### Windows PowerShell

```powershell
$env:RHINOQ_DATABASE_URL = 'postgres://postgres:postgres@localhost:5432/app?sslmode=disable'
$env:RHINOQ_WORKER_NAME = 'reports-worker-1'
```

Environment variables apply only to the current shell unless your deployment
system persists them. Keep credentials out of committed `.env` files. See
[configuration.md](./configuration.md) for embedded worker variables and
[agent.md](./agent.md) for optional Gateway variables.

## Safe first-run sequence

```bash
# 1. Preview the configuration template. This writes nothing.
rhinoq init

# 2. Create rhinoq.config.env.example without overwriting an existing file.
rhinoq init --apply

# 3. Inspect database changes. These commands are read-only.
rhinoq migrate plan
rhinoq migrate sql

# 4. Apply the reviewed migrations.
rhinoq migrate apply

# 5. Fail the deployment if config, connectivity or schema is invalid.
rhinoq doctor

# 6. Open the developer view.
rhinoq workbench
```

## Command index

| Command | Purpose | Reads | Writes |
|---|---|:---:|:---:|
| `rhinoq help [command]` | show terminal documentation | No | No |
| `rhinoq version` | print the source version | No | No |
| `rhinoq init` | preview local initialization | No | No |
| `rhinoq init --apply` | create an environment template | No | File |
| `rhinoq migrate plan` | show applied and pending migrations | DB | No |
| `rhinoq migrate status` | show authoritative migration state | DB | No |
| `rhinoq migrate sql` | print pending SQL for review | DB | No |
| `rhinoq migrate apply` | apply pending migrations safely | DB | DB |
| `rhinoq doctor [--report]` | validate config, DB and schema | DB | No |
| `rhinoq jobs list` | list payload-free job summaries | DB | No |
| `rhinoq queue counts` | count jobs by state | DB | No |
| `rhinoq queue pause` | stop new claims for one queue | DB | DB |
| `rhinoq queue resume` | allow claims for one queue | DB | DB |
| `rhinoq attention` | show work needing a decision | DB | No |
| `rhinoq findings list` | inspect integrity Findings | DB | No |
| `rhinoq findings <transition>` | record a Finding decision | DB | DB |
| `rhinoq rules list` | inspect Rules | DB | No |
| `rhinoq rules create <id>` | register a Rule version from a `.sql` file | DB | DB |
| `rhinoq scan <id>` | verify one enabled Rule against real data | DB | Findings |
| `rhinoq explain <id>` | inspect the safety plan for one Rule | DB/Gateway | Evidence |
| `rhinoq rules enable` | Explain and enable one Rule | DB | DB |
| `rhinoq rules disable` | stop future claims for one Rule | DB | DB |
| `rhinoq rules delete <id>` | preview a Rule deletion | DB | No |
| `rhinoq rules delete <id> --apply` | delete a Rule and its derived rows | DB | DB |
| `rhinoq rules run` | run the long-lived Rule scheduler | DB | DB |
| `rhinoq notify add\|remove` | configure a delivery destination | No | File |
| `rhinoq notify list` | list destinations with endpoints redacted | No | No |
| `rhinoq notify test <name>` | send one synthetic signed event | No | No |
| `rhinoq notify send <name>` | deliver one real Finding | DB | DB |
| `rhinoq workbench` | open the local developer UI; actions require `--actions` | DB | No by default |
| `rhinoq workbench --demo` | open sample data without PostgreSQL | No | No |

`rhinoq explain` persists immutable Explain evidence when it runs against the
database. It does not enable or evaluate the Rule.

## `rhinoq init`

### Purpose

Show the first configuration steps or create a safe example environment file.

```bash
rhinoq init
rhinoq init --apply
```

Without `--apply`, the command only prints its plan. With `--apply`, it creates
`rhinoq.config.env.example` in the current directory. It uses exclusive create
semantics, so an existing file is never overwritten.

The generated file contains worker defaults. It does not:

- create a PostgreSQL database;
- modify application source;
- apply migrations;
- start a worker or Gateway;
- copy values into the current shell.

After reviewing the template, set the required environment variables and run
`rhinoq migrate plan`.

Use the integrity-only plan when the existing application keeps its current
queue, cron or workflow engine:

```bash
rhinoq init --integrity-only
rhinoq init --integrity-only --apply
```

That template contains only `RHINOQ_DATABASE_URL`. It does not configure a
worker, claim loop, heartbeat, retry scheduler, lease reaper or recovery
executor.

## `rhinoq scan`

### Purpose

Verify one enabled Rule against real data and fold what it finds into Findings.
This is the shortest path to a first Finding: it needs no queue, no worker and
no cutover.

```bash
rhinoq scan completed-report-has-output
rhinoq scan completed-report-has-output --subject report_3912
rhinoq scan completed-report-has-output --max-pages 5 --json
```

| Flag | Default | Meaning |
|---|---|---|
| `--subject <id>` | none | verify a single business subject instead of walking all |
| `--cursor <c>` | none | resume an incomplete scan from a previous run |
| `--max-pages <n>` | `100` | page budget for this run, maximum 10000 |
| `--timeout <d>` | `2m` | wall-clock budget for this run |
| `--json` | off | print the summary as JSON |

`--subject` and `--cursor` are mutually exclusive: one asks about a single
record, the other resumes a walk.

### What it does and does not do

Scan opens the integrity plane only. It starts no worker, claims no jobs, runs
no reaper and performs no repair. It reads business data and writes
observations and Findings.

The run is bounded twice, by `--max-pages` and by `--timeout`, and each page is
bounded by the Rule's own `MaxRows`. Stopping on either budget is a result, not
a failure: observations already made are committed, and the printed cursor
resumes the rest.

A passing recheck resolves the Finding it previously opened, so a repaired
subject does not need a manual close.

### Output

```text
Rule:              completed-report-has-output
Pages:             12
Observed:          5842
Passed:            5830
Violated:          12
Findings touched:  12
Duration:          1.84s
Status:            complete

Inspect what was found:
  rhinoq findings list --rule completed-report-has-output
```

## `rhinoq migrate`

### Purpose

Manage the checksum-tracked RhinoQ PostgreSQL schema.

```bash
rhinoq migrate plan
rhinoq migrate status
rhinoq migrate sql
rhinoq migrate apply
```

| Action | Behavior |
|---|---|
| `plan` | lists applied and pending versions and confirms that nothing changed |
| `status` | prints the authoritative installed/pending state |
| `sql` | prints only pending migration SQL, suitable for DBA review |
| `apply` | takes a PostgreSQL advisory lock and commits each pending version |

All four actions require `RHINOQ_DATABASE_URL`. Only `apply` changes the
database.

Recommended production workflow:

```bash
rhinoq migrate plan
rhinoq migrate sql > rhinoq-pending.sql
# Review rhinoq-pending.sql in the deployment change.
rhinoq migrate apply
rhinoq doctor
```

The runner fails closed when:

- an applied migration checksum changed;
- migration history contains a version gap;
- the database schema is newer than the CLI;
- RhinoQ objects exist without authoritative migration history.

It never edits old migration files, invents a baseline or silently repairs
history.

## `rhinoq doctor`

### Purpose

Validate the environment before a process handles production work.

```bash
rhinoq doctor
rhinoq doctor
```

The report checks:

- typed runtime values and bounds;
- worker identity;
- lease, heartbeat and reaper timing;
- PostgreSQL connectivity;
- applied migration checksums and pending versions.

`doctor` is read-only and never calls `migrate apply`.

Any FAIL exits non-zero, so `rhinoq doctor` is already a deployment gate. Add
`--report` when a human wants the diagnosis without the exit code:

```bash
rhinoq doctor
if [ "$?" -ne 0 ]; then
  echo "RhinoQ is not ready"
  exit 1
fi
```

Warnings do not fail CI. Any `FAIL` does.

## `rhinoq jobs list`

### Purpose

Inspect bounded job summaries without exporting payloads.

```bash
rhinoq jobs list [flags]
```

| Flag | Default | Meaning |
|---|---:|---|
| `--queue <name>` | all | restrict results to one queue/job name |
| `--states <csv>` | all | comma-separated job states |
| `--limit <n>` | `50` | maximum rows; accepted range `1..1000` |
| `--offset <n>` | `0` | pagination offset |
| `--json` | false | emit JSON instead of a terminal table |

Valid states are:

```text
pending leased retry_wait blocked dead succeeded cancelled
```

Examples:

```bash
# Jobs that cannot currently make progress.
rhinoq jobs list \
  --queue generate-report \
  --states blocked,dead \
  --limit 50

# A machine-readable page for a script.
rhinoq jobs list --states pending,retry_wait --limit 100 --offset 0 --json
```

The output contains identity, state, attempts, priority and correlation. It
never contains the job payload.

## `rhinoq queue`

### Purpose

Inspect or control new claims for one queue.

```bash
rhinoq queue counts <name>
rhinoq queue pause <name>
rhinoq queue resume <name>
```

`counts` is read-only and prints every state, including zero values.

`pause` writes a queue-control record. Workers stop claiming new jobs from that
queue, but handlers that already own a lease continue running.

`resume` clears the pause and allows future claims again. It does not force an
immediate retry or change a job's `not_before`.

```bash
rhinoq queue counts provider-sync
rhinoq queue pause provider-sync
# Repair or wait for the downstream dependency.
rhinoq queue resume provider-sync
```

## `rhinoq attention`

### Purpose

Show one bounded inbox for cases where execution state alone is not enough.

```bash
rhinoq attention [flags]
```

| Flag | Default | Meaning |
|---|---:|---|
| `--queue <name>` | all safely attributable items | optional queue filter |
| `--limit <n>` | `50` | maximum rows |
| `--offset <n>` | `0` | pagination offset |
| `--json` | false | machine-readable output |

The inbox combines:

- dead jobs;
- blocked executions;
- uncertain effects;
- outcome mismatches;
- live persistent integrity Findings.

Resolved and actively suppressed Findings are excluded. A queue filter does not
guess a queue for a business Finding that has no safe execution correlation.

```bash
rhinoq attention
rhinoq attention --queue generate-report --limit 100 --json
```

The command is read-only.

## `rhinoq findings`

### Purpose

Inspect and record explicit decisions about persistent business-integrity
drift.

### List Findings

```bash
rhinoq findings list [flags]
```

| Flag | Default | Meaning |
|---|---:|---|
| `--rule <id>` | all | filter by Rule |
| `--subject-type <type>` | all | filter by business subject type |
| `--subject <id>` | all | filter by business subject ID |
| `--statuses <csv>` | `open,regressed,acknowledged` | lifecycle filter |
| `--include-suppressed` | false | include active suppressions |
| `--limit <n>` | `50` | maximum rows |
| `--offset <n>` | `0` | pagination offset |
| `--json` | false | machine-readable output |

```bash
rhinoq findings list \
  --rule ready-report-has-output \
  --statuses open,regressed,acknowledged
```

### Transition one Finding

Every transition identifies the exact invariant instance:

```text
--rule
--subject-type
--subject
--version
--actor
```

Available transitions:

| Action | Meaning | Extra required flags |
|---|---|---|
| `acknowledge` | record that a developer owns or understands it | none |
| `resolve` | record that the underlying business state was repaired | `--reason` |
| `ignore` | suppress this exact Finding temporarily | `--until`, `--reason` |
| `false-positive` | mark the result invalid and suppress it temporarily | `--until`, `--reason` |

```bash
rhinoq findings acknowledge \
  --rule ready-report-has-output \
  --subject-type report \
  --subject report_01 \
  --version 1 \
  --actor developer@example.com

rhinoq findings resolve \
  --rule ready-report-has-output \
  --subject-type report \
  --subject report_01 \
  --version 1 \
  --actor developer@example.com \
  --reason 'output object restored'

rhinoq findings false-positive \
  --rule ready-report-has-output \
  --subject-type report \
  --subject report_01 \
  --version 1 \
  --actor developer@example.com \
  --until 24h \
  --reason 'legacy report intentionally has no object'
```

Suppression durations use Go duration syntax such as `30m`, `24h` or `168h`.
Transitions are persisted; they are not local UI preferences.

## `rhinoq rules`

### Purpose

Inspect and run deterministic business-integrity Rules.

### List Rules

```bash
rhinoq rules list [flags]
```

| Flag | Default | Meaning |
|---|---:|---|
| `--scope <job|table>` | all | filter Rule scope |
| `--statuses <csv>` | all | filter lifecycle states |
| `--limit <n>` | `100` | maximum rows |
| `--offset <n>` | `0` | pagination offset |
| `--json` | false | machine-readable output |

### Explain and enable

```bash
rhinoq explain ready-report-has-output
rhinoq rules enable ready-report-has-output
```

`explain` runs the PostgreSQL safety gate and reports query shape, row/plan
budgets and rejection reasons. It does not enable or evaluate the Rule.

`rules enable` runs Explain again. Enable succeeds only when the current
immutable version passes. `rules disable` prevents future page claims:

```bash
rhinoq rules disable ready-report-has-output
```

A page already leased under that version is allowed to finish; disabling does
not rewrite its cursor or evidence.

### Run the scheduler

```bash
rhinoq rules run [flags]
```

| Flag | Default | Meaning |
|---|---:|---|
| `--owner <name>` | hostname/component/PID | unique scheduler identity |
| `--poll <duration>` | `1s` | idle polling interval |
| `--lease <duration>` | `1m` | lease for one evaluation page |
| `--error-backoff <duration>` | `30s` | delay after an evaluation error |
| `--batch <n>` | `4` | maximum Rules claimed per cycle |

This is a long-lived process. Stop it using `Ctrl+C` or `SIGTERM`; it drains
cleanly.

```bash
rhinoq rules run \
  --owner integrity-1 \
  --poll 1s \
  --lease 1m \
  --error-backoff 30s \
  --batch 4
```

Do not run multiple schedulers with the same owner name. Owner/epoch fencing
protects stale writes, but unique identities keep incidents understandable.

## `rhinoq explain`

By default, `explain` connects directly to `RHINOQ_DATABASE_URL`.

If `RHINOQ_AGENT_URL` is set, the CLI calls the optional HTTP Gateway instead:

```bash
export RHINOQ_AGENT_URL='http://127.0.0.1:8080'
export RHINOQ_AGENT_TOKEN='replace-with-the-gateway-token'
rhinoq explain ready-report-has-output
```

The Gateway path is optional. Do not deploy the Gateway only to make this
command work; direct PostgreSQL is the smaller path.

## `rhinoq workbench`

### Purpose

Open the loopback-only developer interface.

```bash
rhinoq workbench [flags]
rhinoq ui [flags]
```

| Flag | Default | Meaning |
|---|---:|---|
| `--demo` | false | use built-in data and skip PostgreSQL |
| `--port <n>` | `8787` | loopback port; `0` chooses an available port |
| `--queue <name>` | all | initial queue filter |
| `--no-open` | false | print the URL without opening a browser |
| `--actions` | false | enable subject recheck and registered guarded repair callbacks |

Examples:

```bash
# Learn the interface without a database.
rhinoq workbench --demo

# Inspect the configured PostgreSQL store.
rhinoq workbench

# Start filtered and choose an available port.
rhinoq workbench --queue generate-report --port 0

# Useful in a remote development environment.
rhinoq workbench --no-open --port 8787
```

Live mode requires `RHINOQ_DATABASE_URL` and an up-to-date schema. The server
binds only to `127.0.0.1`, omits payloads and is read-only unless `--actions`
is supplied. Action mode still accepts only recheck and registered safe repair.

See [workbench.md](./workbench.md) for the Evidence Rail, keyboard controls and
security boundary.

## JSON and pagination for automation

Read commands that support `--json` return one top-level collection:

```json
{
  "jobs": []
}
```

Other collection names are `items`, `findings` and `rules`.

Use bounded pages:

```bash
rhinoq jobs list --limit 100 --offset 0 --json
rhinoq jobs list --limit 100 --offset 100 --json
```

The current preview uses offset pagination. Scripts must stop when a page is
shorter than the requested limit. Do not request unbounded exports.

## Common mistakes

| Symptom | Cause | Fix |
|---|---|---|
| `rhinoq: command not found` / “not recognized” | Go's binary directory is not on `PATH` | add `GOBIN` or `GOPATH/bin`, or use `go run ./cmd/rhinoq` |
| `RHINOQ_DATABASE_URL is empty` | the variable is not set in this process | set it in the same shell and rerun `doctor` |
| `migration state` failure | pending, drifted or incompatible schema | run `migrate plan`; never edit applied SQL |
| `unknown command "work"` | there is no generic CLI worker command | run the Go embedded worker or Node `RhinoQWorker` |
| `jobs list` shows no payload | intentional privacy boundary | fetch payload only inside an authorized handler/API |
| paused queue still has active work | pause affects future claims | wait for leased handlers or cancel through the public API |
| Rule cannot enable | Explain gate rejected it | run `rhinoq explain <id>` and fix query/index/budget |
| Workbench cannot connect | missing URL or pending migration | run `rhinoq doctor` |
| `--until 1d` fails | Go duration syntax has no day unit | use `24h` |

## Current preview boundary

- Tagged prerelease binaries, checksums, a Sigstore bundle and SBOMs are
  downloadable; no prerelease is a production-stability promise.
- The CLI has no `enqueue` command.
- Go handlers run through the embedded library, not a dynamic CLI plugin.
- Job replay/cancel is available through public Go/Node/Gateway APIs, but not
  yet exposed as a direct PostgreSQL CLI command.
- Workbench is read-only by default; `--actions` enables only subject recheck
  and registered guarded repair callbacks, never arbitrary SQL.
- Performance limits are not published until a reproducible benchmark exists.
