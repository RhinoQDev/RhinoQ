import { AsyncLocalStorage } from 'node:async_hooks';

import { setAmbientTraceReader } from './ambient-trace.js';

/**
 * Ambient W3C Trace Context for outgoing Gateway calls.
 *
 * The Agent records the `traceparent` of whoever caused an attempt, which is
 * what lets an operator move from a failed Task to the request that produced
 * it. Getting that value from an inbound HTTP request to an outbound Gateway
 * call is the whole problem this module solves, and the naive answer -- thread
 * it through every function that might eventually enqueue -- is the same
 * "every call site has to remember" shape that produces a correlation gap
 * nobody notices until an incident.
 *
 * `AsyncLocalStorage` is the mechanism because Node already keeps the context
 * alive across awaits, and because it costs no dependency: this SDK ships with
 * an empty `dependencies` field and that is worth more than the convenience of
 * an instrumentation library. `tasks/durable.ts` already uses the same
 * primitive for step keys, so this is an established pattern here rather than a
 * new one.
 *
 * This module is Node-only and must stay off the browser entry point's import
 * graph: `gateway/client.ts` is reachable from `./browser` through
 * `tasks/http.ts`, so it depends on the runtime-agnostic `ambient-trace.js`
 * seam instead of on this file. Loading this module registers the reader, which
 * importing the package root does; a browser build never reaches it and simply
 * sends no ambient trace.
 */
const store = new AsyncLocalStorage<string>();

// Registered on load rather than lazily, so an application that imports the
// package root gets correlation with no configuration. It is idempotent: the
// module is evaluated once.
setAmbientTraceReader(() => store.getStore());

/**
 * Runs `fn` with `traceparent` as the ambient trace for every Gateway call it
 * makes, including calls made after an `await`.
 *
 * A blank or absent value runs `fn` with no ambient trace rather than storing
 * an empty string. Absence is a real state -- a cron tick or a CLI command has
 * no inbound request -- and recording "" would make every untraced attempt
 * appear to share one trace.
 */
export function withTrace<T>(traceparent: string | undefined | null, fn: () => T): T {
  const value = typeof traceparent === 'string' ? traceparent.trim() : '';
  if (!value) {
    return fn();
  }
  return store.run(value, fn);
}

/** The ambient `traceparent`, or undefined outside any {@link withTrace}. */
export function currentTraceParent(): string | undefined {
  return store.getStore();
}

/**
 * Reads a `traceparent` out of an inbound request's headers.
 *
 * It accepts the shapes Node frameworks actually produce: a plain object from
 * `req.headers`, or a `Headers` instance from a fetch-style request. Header
 * names are matched case-insensitively because HTTP does not promise a case and
 * proxies do not preserve one.
 *
 * An array value takes the first entry, which is what Node produces when a
 * header arrives more than once. The specification allows exactly one
 * `traceparent`; taking the first is a deterministic choice, and the Agent
 * validates it either way.
 */
export function traceParentFromHeaders(
  headers: Headers | Record<string, string | string[] | undefined> | undefined,
): string | undefined {
  if (!headers) {
    return undefined;
  }
  const raw =
    typeof (headers as Headers).get === 'function'
      ? (headers as Headers).get('traceparent')
      : findHeader(headers as Record<string, string | string[] | undefined>, 'traceparent');
  const value = Array.isArray(raw) ? raw[0] : raw;
  const trimmed = typeof value === 'string' ? value.trim() : '';
  return trimmed || undefined;
}

function findHeader(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | string[] | undefined {
  const direct = headers[name];
  if (direct !== undefined) {
    return direct;
  }
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === name) {
      return headers[key];
    }
  }
  return undefined;
}

/**
 * Connect/Express-style middleware that makes the inbound `traceparent`
 * ambient for the rest of the request.
 *
 * It is the one line an application adds. Everything enqueued downstream is
 * then correlated without any producer having to know a trace exists.
 *
 * The types are structural rather than imported from `@types/express`: this
 * package depends on nothing at runtime and should not acquire a type
 * dependency to describe two fields it reads.
 */
export function traceContextMiddleware() {
  return function rhinoqTraceContext(
    request: { headers?: Record<string, string | string[] | undefined> },
    _response: unknown,
    next: () => void,
  ): void {
    withTrace(traceParentFromHeaders(request?.headers), next);
  };
}
