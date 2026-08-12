# Fault evidence matrix

`sdks/node/contracts/fault-matrix.json` is the machine-readable inventory of
15 fault scenarios and their executable evidence markers. Run:

```bash
npm --prefix sdks/node run fault:check
npm --prefix sdks/node test
```

The matrix covers SSE loss, polling fallback, stale/duplicate delivery,
capacity release, authorization, provider timeout, lost repair response,
dispatch/bind uncertainty, unsupported cancellation, secret redaction, tenant
isolation and PostgreSQL/projector interruptions.

This is local deterministic and opt-in integration evidence. PostgreSQL and
deployment-shaped cases may skip without their explicitly documented service
configuration. Passing this matrix is not a production-readiness or reliability
claim; it prevents implemented evidence from silently disappearing.
