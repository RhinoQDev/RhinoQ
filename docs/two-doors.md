# Two doors

There are two ways to put RhinoQ into an application, and they produce opposite
answers to "did this save me code". The difference is one architectural
decision, and until this page existed nothing told you it was there.

## Door 1 — RhinoQ's Task API is your API

Your frontend polls `GET /tasks/:id/summary`. The response shape is
`TaskSummary`, which RhinoQ defines. You mount two middlewares and write the
dispatch call.

```js
const app = await rhinoq({ pool, queue, events, ownerFromRequest });

server.use('/tasks', app.routes());                          // read + cancel
server.use(app.workbench({ token, basePath: '/admin' }));    // operator console

await app.dispatch(taskId, items.map((item, index) => ({ key: `item-${index}`, data: item })));
```

You do not write: a status endpoint, a progress endpoint, a cancel endpoint, a
per-item results endpoint, the polling contract, the state machine, the item
table, the aggregate counters, the "did the last item just finish" check, or an
operator console.

You give up: control of the wire format. `TaskSummary` is versioned and
additive, but it is RhinoQ's shape, not yours.

**This is the door a new project should take.** It is the only one where the
code-reduction argument is real, and a project with no frontend yet has no wire
format to protect.

## Door 2 — your HTTP contract, RhinoQ underneath

Your frontend keeps polling `GET /jobs/:id` and getting the shape it already
gets. RhinoQ is the durable state underneath, and you write the read layer that
maps its snapshot onto your contract.

```js
app.get('/jobs/:id', async (request, response) => {
  const task = await tasks.getTaskSummary(request.params.id);
  response.json(toMyContract(task));   // your shape, your fields, your names
});
```

You still get: the state machine, per-item attempts, the exactly-once settled
signal, the projector lease, reconciliation, the operator console.

You still write: every route, every field mapping, and whatever realtime
transport you already had. That is not a small amount of code, and on a first
measurement it can exceed what you deleted.

**This is the door an existing system usually has to take**, and it is the
honest reason an evaluation can conclude "RhinoQ cost me lines". Both readings
are correct; they are answers to different questions.

## The numbers

Measured in this repository, on the code that ships here:

```bash
grep -vcE '^\s*(//|/\*|\*|$)' examples/fanout-bullmq/server.mjs
```

| What | Non-comment lines |
|---|---:|
| `examples/fanout-bullmq/server.mjs` — Door 1, long form: API, worker, bridge, reconciler, both HTTP surfaces, exactly-once settlement | **164** |
| `create-rhinoq-app` template `server.mjs` — Door 1 via `rhinoq()`, plus a storage-drift demo the example does not have | **123** |

An independent evaluation built the same feature set three times — by hand on
PostgreSQL and BullMQ, with RhinoQ behind a hand-written HTTP contract, and with
RhinoQ's own Task API — and measured 638, 689 and 322 non-comment lines
respectively. Scoped to the same features on both sides, that is 322 against
508: **37% less code through Door 1, 8% more through Door 2.**

Treat those three numbers as a reproducible local benchmark, not as adoption
evidence. They come from one engineer, one afternoon, one feature. No design
partner has yet published a before/after count from a real system, and until one
has, "RhinoQ reduces code" is a claim about a benchmark.

## Choosing

| | Door 1 | Door 2 |
|---|---|---|
| New project, no frontend contract yet | **yes** | |
| Existing endpoints other teams consume | | yes |
| Mobile clients you cannot redeploy | | yes |
| You want the shortest path to something running | **yes** | |
| You need field names to match an existing schema | | yes |

You can also start at Door 1 and add your own endpoints later: `app.tasks` is
the same client, and nothing stops you serving both shapes from the same data
while a migration runs.
