/**
 * The seam between the Gateway client and Node's async context.
 *
 * `gateway/client.ts` is reachable from the browser entry point through
 * `tasks/http.ts`, so anything it imports statically ends up in a browser
 * bundle. `AsyncLocalStorage` lives in `node:async_hooks`, which does not exist
 * there, and a static import of it would break every bundler that resolves the
 * browser entry.
 *
 * So the client depends on this module, which knows nothing about Node, and the
 * Node-only `gateway/trace.ts` registers itself here when it is loaded. The
 * package root exports `trace.js`, so importing `@rhinoq/node` wires the reader
 * up with no configuration; importing `@rhinoq/node/browser` never loads it and
 * the reader simply stays unset.
 *
 * A registry rather than a dynamic import because reading the ambient trace has
 * to be synchronous: it happens while building the headers of a request that is
 * already being sent.
 */
let reader: (() => string | undefined) | undefined;

/**
 * Installs the function the client asks for the ambient trace.
 *
 * Called by `gateway/trace.ts` at module load. An application should not need
 * this, but it is exported so a runtime with its own context mechanism -- a
 * different async-context implementation, or an existing OpenTelemetry setup --
 * can supply one without patching the client.
 */
export function setAmbientTraceReader(next: (() => string | undefined) | undefined): void {
  reader = next;
}

/**
 * The ambient `traceparent`, or undefined when nothing is registered or no
 * trace is active. Never throws: a failing context lookup must not be able to
 * break the request it was decorating.
 */
export function ambientTraceParent(): string | undefined {
  try {
    return reader?.();
  } catch {
    return undefined;
  }
}
