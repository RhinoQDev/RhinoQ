# Report export — first real RhinoQ application

This consumer example shows the complete first application loop without
importing RhinoQ source code. It installs the verified npm package and uses:

- PostgreSQL durable Task and Execution state;
- a manual/custom runtime with stable identities;
- server-side demo sessions for two owners in one tenant;
- a private result reference resolved only after owner authorization;
- filesystem storage with real write/readback/checksum verification;
- one verified success and one runtime-success/missing-output Task left
  `uncertain`;
- a server-side cancellation guard that returns `RHINOQ_UNSUPPORTED` before
  any Task mutation (the manual runtime reports cancellation as unsupported);
- Task Center and the operator Workbench.

`recovery.mjs` is the application-owned repair composition for the missing
output case. It uses RhinoQ's preview-first `GuardedRecovery`, requires a
different approver, consumes an idempotency fence before provider mutation,
performs storage readback and only closes the Task after the post-check is
verified. Unknown readback remains `uncertain` and replay does not write again.
Pass the installed package's `GuardedRecovery` to the factory; the relative
SDK checkout is not imported by either the application or its tests, so a copy
of this example verifies the same published package that it runs.

Use a disposable PostgreSQL database because the example installs the isolated
RhinoQ Task schema:

```powershell
npm install
$env:DATABASE_URL='postgres://postgres:postgres@127.0.0.1:5432/rhinoq_report_export'
$env:RHINOQ_OPERATOR_TOKEN='replace-with-a-long-random-demo-token'
npm test
npm start
```

Open the printed Alice link to see the successful report. Open the Bob link in
a separate browser profile to see an Execution that succeeded while its Task
is honestly `uncertain` because storage readback found no output. Each session
receives only its owner's Tasks.

Open `/operator-login`, enter `RHINOQ_OPERATOR_TOKEN`, and the server exchanges
it for an HttpOnly, SameSite cookie scoped to `/admin` before redirecting to the
Workbench. The token is never placed in the page, URL, or browser-readable
storage.

The server also prints two guarded-recovery links. Open the support link to
preview the repair, then open the approver link in a separate browser profile
to approve and execute it. The same actor cannot perform both roles. Submitting
approval again rehearses a lost response: the idempotency ledger returns the
recorded result and does not write the provider output twice.

Open the printed notification fixture to exercise 204, 429, 503, 403 and
timeout behavior through the real Node notification sender. It records attempt
count and stable event ID in the page. The receivers are deterministic local
stubs, clearly labelled as transport evidence rather than external-provider
proof.

The sessions and filesystem provider are deliberately local test doubles. A
real application must replace `auth.mjs` with its authentication/session
lookup and `storage.mjs` with an authorized provider adapter. Do not send the
stored `report://` reference or storage credentials directly to a browser.
