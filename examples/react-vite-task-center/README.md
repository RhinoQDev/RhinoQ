# React/Vite Embedded Task Center

This application proves that `RhinoQTaskCenter` is ordinary React rather than
a Next.js-only surface. It uses the disposable RhinoQ demo as its
application-owned API during local evaluation.

From the repository root, start the API and synthetic worker:

```bash
npm --prefix sdks/node run build
node sdks/node/dist/cli/rhinoq.js dev --demo --port=18891
```

In another terminal (development mode):

```bash
npm install --prefix examples/react-vite-task-center
npm --prefix examples/react-vite-task-center run dev
```

Or verify the exact production bundle:

```bash
npm --prefix examples/react-vite-task-center run build
npm --prefix examples/react-vite-task-center run preview
```

Open `http://127.0.0.1:4173`. The Vite proxy keeps cookies and SSE on the
application origin while forwarding only the owner Task API to the disposable
demo. In a real application, replace that proxy with a backend route that
derives owner and tenant from the authenticated session.

The screen demonstrates business/order alias search, saved views encoded in
the URL, Task drawer deep links, realtime identity preservation, approval,
fail-closed provider confirmation, artifact preview/download and brand tokens.
Playwright exercises desktop, mobile and keyboard behavior in CI. The synthetic
demo is not authentication evidence: use the owner/tenant middleware contract
and the tenant authorization tests when replacing the proxy with your backend.

Outside this repository, install the public prerelease with:

```bash
npm install @rhinoq/node@next react react-dom
```

The example deliberately does not expose an operator token or use the
display-only `currentUser` value for authorization.
