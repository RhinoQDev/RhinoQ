# RhinoQ quickstart

To see the product without infrastructure first, run `npx rhinoq dev --demo`.
It opens a disposable Workbench with synthetic progress, result and failure
states. The real PostgreSQL-backed tour starts below.

Use this page for the first successful run. It requires no queue, worker or
application code. The shortest real path is `npx rhinoq up`: RhinoQ starts the
disposable PostgreSQL 16 profile, applies the schema, creates a fixture and
opens the Workbench in one process.

RhinoQ is currently a prerelease for evaluation and controlled pilots. The
commands below pin the verified `0.1.0-beta.22` release.

## What you need

- Node.js 22 or 24;
- Docker Desktop with the Docker engine running;
- PowerShell on Windows, or a POSIX shell on macOS/Linux;
- port `55432` available locally.

You do **not** need Redis, BullMQ, Go or provider credentials for this tour.

## 1. Install and start the real local profile

```bash
mkdir rhinoq-first-run
cd rhinoq-first-run
npm init -y
npm install @rhinoq/node@0.1.0-beta.22 pg
npx rhinoq up
```

Keep this command open while exploring the Workbench. It writes only ignored
`.rhinoq/compose.local.yml` and `.env.rhinoq.local` files. Use
`npx rhinoq up --dry-run` first if you want to inspect the plan without Docker.

The remaining manual steps are useful when Docker policy or an existing
PostgreSQL instance prevents `up` from being used.

## 2. Start PostgreSQL manually

PowerShell:

```powershell
docker run --name rhinoq-quickstart-db `
  -e POSTGRES_USER=rhinoq `
  -e POSTGRES_PASSWORD=rhinoq `
  -e POSTGRES_DB=rhinoq `
  -p 55432:5432 `
  -d postgres:16-alpine
```

macOS/Linux:

```bash
docker run --name rhinoq-quickstart-db \
  -e POSTGRES_USER=rhinoq \
  -e POSTGRES_PASSWORD=rhinoq \
  -e POSTGRES_DB=rhinoq \
  -p 55432:5432 \
  -d postgres:16-alpine
```

Wait until PostgreSQL is ready:

```bash
docker exec rhinoq-quickstart-db pg_isready -U rhinoq -d rhinoq
```

Continue only after it prints `accepting connections`.

## 3. Create a disposable Node project

```bash
mkdir rhinoq-first-run
cd rhinoq-first-run
npm init -y
npm install @rhinoq/node@0.1.0-beta.22 pg
```

Using an empty directory keeps the tour separate from your application. No
global npm installation is required.

## 4. Point RhinoQ at PostgreSQL

PowerShell:

```powershell
$env:RHINOQ_DATABASE_URL = 'postgresql://rhinoq:rhinoq@127.0.0.1:55432/rhinoq'
```

macOS/Linux:

```bash
export RHINOQ_DATABASE_URL='postgresql://rhinoq:rhinoq@127.0.0.1:55432/rhinoq'
```

Set the variable in the same terminal that runs the next command.

## 5. Run the bounded evaluation

```bash
npx rhinoq eval
```

A successful run reports `PASS` for:

- PostgreSQL connectivity;
- Task schema installation or verification;
- durable fixture creation;
- owner Task API;
- Task Center HTML;
- Workbench HTML.

It intentionally reports `NOT VERIFIED` for browser interaction, an external
provider and deployment faults. Those are separate tests, not failures in this
quickstart.

## 6. Choose the next path

| If your application uses… | Continue with… |
|---|---|
| BullMQ | [the BullMQ example](../examples/fanout-bullmq/README.md) |
| no existing queue; PostgreSQL should execute jobs | [the native PostgreSQL queue](./postgres-queue.md) |
| another queue or custom runtime | [the portable Node adapter guide](../sdks/node/README.md) |
| PostgreSQL checks without a queue | [the integrity-only example](../examples/integrity-only/README.md) |
| a realistic report-export workflow | [the report-export example](../examples/report-export/README.md) |
| a production deployment | [the production checklist](./production-checklist.md) |

The longer [beginner guide](./start-here.md) explains Tasks, Executions,
verification, uncertainty, operator recovery and every optional product layer.

## Stop and clean up

The database is disposable. Remove it when you finish:

```bash
docker rm -f rhinoq-quickstart-db
```

Do not copy the quickstart database credentials into staging or production.

## Common first-run problems

| Message or symptom | Fix |
|---|---|
| Docker cannot connect | Start Docker Desktop and wait for the engine to become ready. |
| container name already exists | Reuse it if it is healthy, or remove only `rhinoq-quickstart-db` and rerun step 1. |
| port `55432` is already allocated | Choose another host port and change the port in `RHINOQ_DATABASE_URL` to match. |
| `RHINOQ_DATABASE_URL is empty` | Set it again in the same terminal. |
| connection refused | Run the `pg_isready` command from step 1 and check the URL and port. |
| npm selects another release | Keep the exact `@rhinoq/node@0.1.0-beta.22` version shown above. |
