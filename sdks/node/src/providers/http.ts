import type {
  ProviderConfirmation,
  ProviderOperationOptions,
  ProviderOperationRecord,
} from '../gateway/types.js';
import type { RhinoQLifecycleModule } from '../runtime/modules.js';

export interface HttpProviderRequest {
  input: RequestInfo | URL;
  init?: RequestInit;
}

export interface HttpReferenceAdapter<T> {
  module?: RhinoQLifecycleModule;
  /** Builds the provider request. The key is injected into the headers below. */
  request(idempotencyKey: string): HttpProviderRequest;
  /** Parses a successful response into the provider's result shape. */
  parse(response: Response): Promise<T> | T;
  /** Reads the provider back and decides whether the mutation happened. */
  confirm(operation: ProviderOperationRecord): Promise<ProviderConfirmation>;
  /** Optional provider-specific identity and evidence for the accepted result. */
  providerId?(result: T): string;
  evidence?(result: T): string | undefined;
  /** Injectable fetch for tests or an application's HTTP transport. */
  fetch?: typeof globalThis.fetch;
}

/**
 * A bounded error for non-2xx responses. ProviderOperation deliberately turns
 * this into an unknown result and asks `confirm` to prove what happened; a
 * status code alone is not treated as permission to repeat a mutation.
 */
export class HttpProviderError extends Error {
  readonly status: number;
  readonly body: string;

  constructor(status: number, body: string) {
    super(`HTTP provider returned ${status}${body ? `: ${body}` : ''}`);
    this.name = 'HttpProviderError';
    this.status = status;
    this.body = body;
  }
}

/**
 * Reference adapter for idempotent HTTP mutations. It owns only transport
 * mechanics: RhinoQ still owns reservation, uncertainty and retry policy,
 * while the application supplies provider-specific read-back semantics.
 */
export function httpProviderAdapter<T>(
  adapter: HttpReferenceAdapter<T>,
): Pick<ProviderOperationOptions<T>, 'execute' | 'confirm' | 'providerId' | 'evidence' | 'module'> {
  if (!adapter || typeof adapter.request !== 'function' || typeof adapter.parse !== 'function' ||
    typeof adapter.confirm !== 'function') {
    throw new TypeError('HTTP provider adapter requires request, parse and confirm callbacks');
  }
  const fetchImpl = adapter.fetch ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    throw new TypeError('HTTP provider adapter requires global fetch or an injected fetch implementation');
  }

  return {
    ...(adapter.module ? { module: adapter.module } : {}),
    execute: async (idempotencyKey) => {
      const request = adapter.request(idempotencyKey);
      if (!request || request.input === undefined || request.input === null) {
        throw new TypeError('HTTP provider request must include input');
      }
      const init = request.init ?? {};
      const headers = new Headers(init.headers);
      const existing = headers.get('Idempotency-Key');
      if (existing !== null && existing !== idempotencyKey) {
        throw new TypeError('HTTP provider request contains a conflicting Idempotency-Key');
      }
      headers.set('Idempotency-Key', idempotencyKey);
      const response = await fetchImpl(request.input, { ...init, headers });
      if (!response.ok) {
        throw new HttpProviderError(response.status, await boundedResponseBody(response));
      }
      return adapter.parse(response);
    },
    confirm: adapter.confirm,
    providerId: adapter.providerId,
    evidence: adapter.evidence,
  };
}

async function boundedResponseBody(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, 2048);
  } catch {
    return '';
  }
}
