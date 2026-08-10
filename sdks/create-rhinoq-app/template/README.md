# RhinoQ async tasks

```bash
npm start
```

Brings up PostgreSQL and Redis, applies the schema, runs a 50-item batch and
opens <http://localhost:3000>. The user-facing Task Center is at `/task-center`.
Open `/operator-login` and enter the local operator token `let-me-in` to reach
the Workbench. The scaffold exchanges it for an HttpOnly, SameSite cookie and
binds the server to loopback; replace this local login with your application's
operator authentication before deploying it.

The home page is the Overview. Overview, Tasks and Workbench use same-tab
navigation, and each Task links to `/task-center/{taskId}` for its owner-facing
progress, guidance and attempt timeline.

The RhinoQ integration itself is deliberately small:

```js
const app = await rhinoq({ pool, queue, events, ownerFromRequest });
server.use(app.http({
  operatorToken: OPERATOR_TOKEN,
  workbenchPath: '/operator-login',
})); // one middleware
await app.dispatch(taskId, items);
```

That one middleware connects the owner-scoped API, live Task Center and
cross-owner Workbench. The worker and business payload remain application code;
the task state machine, progress, retry attempts, cancellation, reconciliation
and operator views do not.

## What is in here

| File | What it is |
|---|---|
| `server.mjs` | the whole application: worker, RhinoQ and all HTTP surfaces |
| `ui.mjs` | one page, no build step, polling the same Task API your frontend would |
| `verify.mjs` | the verification pass you would put on a schedule |
| `start.mjs` | the bootstrap `npm start` runs; delete it once you have your own database |
| `docker-compose.yml` | a disposable PostgreSQL and Redis on ports nothing else was using |

RhinoQ creates its isolated tables in the `rhinoq_task` schema. It creates no
queue or worker tables and does not alter application-owned tables.

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
