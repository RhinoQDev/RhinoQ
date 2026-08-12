import type { TaskResult } from '../gateway/types.js';

export interface ResultAccessContext { ownerId: string; tenantId: string; request: Request }
export interface ResultAccess { url: string; expiresAt?: string }

export interface SignedResultOptions {
  resolve(reference: string, ownerId: string, request: Request): Promise<string | { url: string; expiresAt?: string }> | string | { url: string; expiresAt?: string };
}

/** Loopback-only resolver for development. */
export function localResult(options: { route?: string } = {}) {
  const route = options.route ?? '/rhinoq-results/';
  return async (result: TaskResult, request: Request, ownerId: string, tenantId = 'default'): Promise<ResultAccess> => {
    requireResultContext(ownerId, tenantId);
    const origin = new URL(request.url);
    if (!['localhost', '127.0.0.1', '::1'].includes(origin.hostname)) throw new TypeError('localResult is development-only and requires a loopback host');
    return { url: new URL(`${route}${encodeURIComponent(result.reference)}`, origin).toString() };
  };
}

/** Application proxy resolver; the browser receives no storage reference. */
export function proxyResult(options: { route: (context: ResultAccessContext, result: TaskResult) => string }) {
  if (typeof options?.route !== 'function') throw new TypeError('proxyResult requires route(context, result)');
  return async (result: TaskResult, request: Request, ownerId: string, tenantId = 'default'): Promise<ResultAccess> => {
    requireResultContext(ownerId, tenantId);
    return { url: new URL(options.route({ ownerId, tenantId, request }, result), request.url).toString() };
  };
}

/** S3-compatible adapter without coupling RhinoQ to a cloud SDK. */
export function s3CompatibleResult(options: { sign(reference: string, context: ResultAccessContext): Promise<ResultAccess | string> | ResultAccess | string }) {
  if (typeof options?.sign !== 'function') throw new TypeError('s3CompatibleResult requires sign');
  return async (result: TaskResult, request: Request, ownerId: string, tenantId = 'default'): Promise<ResultAccess> => {
    requireResultContext(ownerId, tenantId);
    const value = await options.sign(result.reference, { ownerId, tenantId, request });
    const access = typeof value === 'string' ? { url: value } : value;
    if (new URL(access.url).protocol !== 'https:') throw new TypeError('s3CompatibleResult requires an HTTPS signed URL');
    return access;
  };
}

function requireResultContext(ownerId: string, tenantId: string): void {
  if (!ownerId?.trim()) throw new TypeError('result resolver requires authenticated ownerId');
  if (!tenantId?.trim()) throw new TypeError('result resolver requires authorized tenantId');
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
