# Node.js example

These examples match the development-preview `@rhinoq/node` API.

## 1. Build the SDK archive

Run from the RhinoQ repository:

```bash
cd sdks/node
npm ci
npm test
npm pack
```

`npm ci` installs locked development dependencies. `npm test` builds `dist/`
and validates the SDK. `npm pack` creates
`rhinoq-node-0.1.0-dev.tgz`.

## 2. Prepare a throwaway Node application

```bash
mkdir rhinoq-node-example
cd rhinoq-node-example
npm init -y
npm pkg set type=module
npm install /absolute/path/to/rhinoq/sdks/node/rhinoq-node-0.1.0-dev.tgz pg
```

Copy `producer.mjs` and/or `worker.mjs` from this directory into that
application. Replace the archive path with the real path on your machine.

## 3. Know what each example does

- [`producer.mjs`](./producer.mjs) uses PostgreSQL directly and needs no
  Gateway. It enqueues one `generate-report` job and exits after closing its
  pool.
- [`worker.mjs`](./worker.mjs) runs a Node handler through the optional HTTP
  Gateway. It is long-lived and exits gracefully on `Ctrl+C`, `SIGINT` or
  `SIGTERM`.

## 4. Set environment variables

Producer:

```bash
export DATABASE_URL='postgres://postgres:postgres@localhost:5432/app'
node producer.mjs
```

Without an argument, the producer generates a new report ID so the example can
be run repeatedly. Pass an explicit ID twice to observe idempotent enqueue:

```bash
node producer.mjs report_01
node producer.mjs report_01
```

Both commands print the same RhinoQ job ID.

Worker:

```bash
export RHINOQ_GATEWAY_URL='http://127.0.0.1:8080'
export RHINOQ_GATEWAY_TOKEN='development-secret-change-me'
node worker.mjs
```

The worker requires a separately running `rhinoq-agent` Gateway. The producer
does not. PostgreSQL migrations and the `generate-report` allowlist row must
already exist.

See [`docs/nodejs.md`](../../docs/nodejs.md) for the complete four-terminal
walkthrough, PowerShell environment syntax, Gateway startup, API reference and
troubleshooting.
