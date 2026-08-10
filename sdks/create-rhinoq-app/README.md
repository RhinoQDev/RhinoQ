# create-rhinoq-app

```bash
npx create-rhinoq-app my-batch
cd my-batch
npm start
```

One command to a working async-task application: live progress, working cancellation,
retries recorded per attempt, a Task Center and an operator Workbench — plus a button that
deletes the output of a job the queue reported as `completed`, so you can watch
the difference between "the queue says done" and "the work happened".

The generated Overview, Task Center, owner Task detail and Workbench are linked
as one same-tab journey. Retry and result actions appear only when the host
application configured the corresponding safe handler.

It brings its own PostgreSQL and Redis through `docker compose`, on ports it
checks are free first, and applies the schema itself. Nothing needs to exist
beforehand except Docker and Node 22.

Without Docker, point `RHINOQ_DATABASE_URL` and `REDIS_URL` in the generated
`.env` at a PostgreSQL and Redis you already run, and `npm start` skips straight
to migrating.

## Options

| Flag | Effect |
|---|---|
| `--no-install` | write the files and stop |
| `--sdk <spec>` | use a different `@rhinoq/node` version or a local path |

## What it writes

A single-process application — worker, RhinoQ wiring, all HTTP surfaces and a
one-page UI with no build step. It is meant to be read and then edited, not
treated as a black box: `server.mjs` is the whole loop.
