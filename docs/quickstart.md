# RhinoQ quickstart

Use this page for the first successful run. It requires no queue, worker or
application code. In about five minutes you will start a disposable PostgreSQL
database and ask RhinoQ to create and read a real durable Task.

RhinoQ is currently a prerelease for evaluation and controlled pilots. The
commands below pin the verified `0.1.0-beta.12` release.

## What you need

- Node.js 22 or 24;
- Docker Desktop with the Docker engine running;
- PowerShell on Windows, or a POSIX shell on macOS/Linux;
- port `55432` available locally.

You do **not** need Redis, BullMQ, Go or provider credentials for this tour.

## 1. Start PostgreSQL

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

## 2. Create a disposable Node project

```bash
mkdir rhinoq-first-run
cd rhinoq-first-run
npm init -y
npm install @rhinoq/node@0.1.0-beta.12 pg
```

Using an empty directory keeps the tour separate from your application. No
global npm installation is required.

## 3. Point RhinoQ at PostgreSQL

PowerShell:

```powershell
$env:RHINOQ_DATABASE_URL = 'postgresql://rhinoq:rhinoq@127.0.0.1:55432/rhinoq'
```

macOS/Linux:

```bash
export RHINOQ_DATABASE_URL='postgresql://rhinoq:rhinoq@127.0.0.1:55432/rhinoq'
```

Set the variable in the same terminal that runs the next command.

## 4. Run the bounded evaluation

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

## 5. Choose the next path

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
| npm selects another release | Keep the exact `@rhinoq/node@0.1.0-beta.12` version shown above. |
