# Compatibility matrix

This matrix records automated coverage for the current checkout. It is not a
promise that unlisted versions are incompatible, and it is not a substitute
for an adopter's upgrade rehearsal.

| Component | Automated coverage | Evidence |
|---|---|---|
| Node.js | 22, 24 | Node SDK CI matrix |
| PostgreSQL | 16 | integration and non-superuser RLS jobs |
| Redis | 7 | gating BullMQ fan-out service |
| BullMQ | 5.81.3 | pinned example manifest and gating fan-out smoke |
| Go | 1.26.5 toolchain | `go.mod` and Go CI |

The PostgreSQL harness creates application roles with `NOSUPERUSER` and
`NOBYPASSRLS`, exercises tenant-scoped reads and writes, and checks the upgrade
invariants introduced by migration 026. Before a pilot, rehearse the actual
source schema and credentials using [`migration-rollback.md`](./migration-rollback.md);
the repository does not claim that a generic rollback can undo application
writes made after migration.

Run the drift gate with:

```bash
node .github/scripts/verify-compatibility.mjs
```
