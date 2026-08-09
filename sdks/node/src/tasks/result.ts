import type { TaskResult } from '../gateway/types.js';

export interface SignedResultOptions {
  resolve(reference: string, ownerId: string, request: Request): Promise<string | { url: string; expiresAt?: string }> | string | { url: string; expiresAt?: string };
}

/** Owner-aware conversion from a durable reference to a short-lived URL. */
export function signedResult(options: SignedResultOptions) {
  if (!options || typeof options.resolve !== 'function') throw new TypeError('signedResult requires resolve');
  return async (result: TaskResult, request: Request, ownerId: string) => {
    const resolved = await options.resolve(result.reference, ownerId, request);
    const value = typeof resolved === 'string' ? { url: resolved } : resolved;
    if (!value?.url) throw new TypeError('signedResult resolver returned no URL');
    const url = new URL(value.url, request.url);
    if (url.protocol !== 'https:' && url.hostname !== '127.0.0.1' && url.hostname !== 'localhost') {
      throw new TypeError('signedResult requires HTTPS outside loopback');
    }
    return { url: url.toString(), ...(value.expiresAt ? { expiresAt: value.expiresAt } : {}) };
  };
}
