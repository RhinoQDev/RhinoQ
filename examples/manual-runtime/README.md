# Manual/custom runtime example

This example proves the portable Task lifecycle without BullMQ, Redis or a Go
runtime. A tiny push adapter emits normalized runtime facts into
`RuntimeTaskProjector`; PostgreSQL remains authoritative for Task state.

Use a disposable PostgreSQL database because the example installs RhinoQ's
isolated Task schema:

```bash
npm install
export DATABASE_URL='postgres://postgres:postgres@127.0.0.1:5432/rhinoq_manual'
npm start
```

PowerShell:

```powershell
npm install
$env:DATABASE_URL='postgres://postgres:postgres@127.0.0.1:5432/rhinoq_manual'
npm start
```

The printed Task should be `succeeded`, with `1/1` progress and one manual
Execution. Replace `createManualRuntimeAdapter` with an application adapter that
implements the same portable contract. Runtime-specific retry inference,
polling, cancellation and credentials stay in that adapter.

This is a development proof, not a supported production runtime adapter.
