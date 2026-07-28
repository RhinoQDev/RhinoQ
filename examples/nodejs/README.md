# Node.js example

These examples match the development-preview `@rhinoq/node` API.

Build and pack the SDK first:

```bash
npm --prefix sdks/node ci
npm --prefix sdks/node pack
```

In a throwaway Node project, install the generated tarball plus `pg`, copy the
example you want, and set the environment variables described in
[`docs/nodejs.md`](../../docs/nodejs.md).

- [`producer.mjs`](./producer.mjs) uses PostgreSQL directly and needs no
  Gateway.
- [`worker.mjs`](./worker.mjs) runs a Node handler through the optional HTTP
  Gateway.
