# Realtime transports

RhinoQ uses authoritative, monotonically versioned Task snapshots. Realtime is
only a delivery optimization: a reconnect always converges from PostgreSQL.

## Which transport should I choose?

Use SSE for normal Task progress. It needs no WebSocket server, works through
ordinary HTTP infrastructure and already falls back to bounded polling in
`TaskStore` and the React package.

Use `createTaskWebSocketHub()` when the application already has a WebSocket
endpoint or one browser must watch many Tasks concurrently. The hub is
stack-neutral: adapt `ws`, Socket.IO, uWebSockets.js or a managed runtime to the
small `send()`, `close()` and optional `bufferedAmount` peer boundary.

```ts
const hub = createTaskWebSocketHub(app.tasks, {
  maxConnections: 5_000,
  maxSubscriptionsPerConnection: 100,
  maxBufferedBytes: 1_048_576,
  maxMessageBytes: 16_384,
});

const channel = hub.accept(peer, { ownerId: authenticatedUser.id, tenantId });
socket.on('message', (bytes) => channel.receive(bytes));
socket.on('close', () => channel.close());
```

When the hub is composed with `createRhinoQApp()`, pass its invalidator as the
optional `realtime` hook. Producer dispatches and runtime projection writes then
trigger owner-scoped invalidation automatically; the hook is best-effort and a
broken socket path cannot fail a durable Task write:

```ts
const app = await createRhinoQApp({
  pool, adapters, realtime: { invalidate: hub.invalidate },
});
```

The client sends `{"type":"subscribe","taskId":"task-1","lastVersion":4}`,
`unsubscribe`, or `ping`. Server frames have `schemaVersion: 1` and are `ready`,
`task.snapshot`, `task.unsubscribed`, `heartbeat`, `pong`, or `error`. Never
derive `ownerId` or `tenantId` from a client frame; pass them from the
authenticated upgrade request.

## Why the hub can be faster than hand-written sockets

For every refresh, subscriptions are grouped by tenant, owner and Task. RhinoQ
performs one owner-fenced authoritative read per group, rejects stale versions,
serializes a changed snapshot once and fans that frame out to all matching
connections. It bounds buffered bytes and closes slow consumers instead of
allowing process memory to grow without limit. Call
`hub.invalidate(taskId, identity, entityVersion)` is still available for
external writes or LISTEN/NOTIFY adapters; the application hook above covers
in-process dispatch and projection writes. The hub uses its subscription index to refresh
only that owner group, coalesces invalidations arriving during an in-flight
read, and serves later subscribers from the already serialized newest frame.
The bounded interval remains only a recovery path for missed signals.

For very large or multi-region fan-out, place Redis or NATS behind an
application adapter as an **invalidation signal** only. Publish `taskId` and
version, never the full canonical Task state. PostgreSQL remains truth and the
hub still performs an owner-scoped snapshot read. Do not add a broker merely to
replace SSE for a normal dashboard: it increases operational cost without
making Task execution itself faster.

The hub does not move lease, retry, cancellation, effect or Task state-machine
correctness out of the Go engine. It also does not authenticate HTTP upgrades,
choose origin rules or guess application authorization.
