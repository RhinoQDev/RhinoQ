# RhinoQ fan-out

```bash
npm start
```

Brings up PostgreSQL and Redis, applies the schema, runs a 50-item batch and
opens <http://localhost:3000>. The operator console is at `/admin` and expects
the header `x-operator-token: let-me-in`.

## What is in here

| File | What it is |
|---|---|
| `server.mjs` | the whole application: worker, RhinoQ, both HTTP surfaces |
| `ui.mjs` | one page, no build step, polling the same Task API your frontend would |
| `verify.mjs` | the verification pass you would put on a schedule |
| `start.mjs` | the bootstrap `npm start` runs; delete it once you have your own database |
| `docker-compose.yml` | a disposable PostgreSQL and Redis on ports nothing else was using |

Three tables are created, in a schema called `rhinoq_task`. No queue tables, no
worker tables, nothing touching your own.

## The part that is not a job queue

BullMQ tells you a job finished. It cannot tell you the work happened.

Press **Delete one finished output**. It removes the output file of an item the
queue reported as `completed` — and nothing in BullMQ changes: the job is still
`completed`, its return value still names the file, and any dashboard built on
queue state still says the work is done.

Then press **Verify storage**. That runs `objectExists` over the finished items
and writes each answer to `rhinoq_verifications`, with three outcomes rather
than two: `present`, `missing`, and `unknown` for the checks that could not run.
Collapsing `unknown` into either of the others is how drift disappears whenever
the network hiccups.

`npm run verify` is the same pass as a scheduled job, and exits non-zero when
something finished but its output is gone.

## Where the decisions live

```js
const app = await rhinoq({ pool, queue, events, ownerFromRequest });
```

That call picks `terminalProjection`, the retry policy projection, the projector
lease, the reconciliation sweep and the terminal-failure classifier. They have
one right answer for a queue-backed fan-out and getting them wrong is silent —
the wrong `terminalProjection` closes a batch on its first finished item.

Everything underneath is still reachable: `app.bridge` and `app.tasks` are the
same objects the long-form API gives you. When you outgrow a default, take the
one you need and leave the rest.

## Next

- `npm run doctor` — reads the running system, not the configuration: batches
  that stopped moving, items all terminal while the Task is still open, attempts
  dispatched but never observed.
- `app.audit(taskId)` — every attempt whose stored state disagrees with the
  queue. Read-only, safe to call while the projector is live.
- `npm run db:down` — throws the database away.
