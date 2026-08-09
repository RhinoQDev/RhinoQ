import { RhinoQError } from '../gateway/client.js';
import type { TaskWaitpoint, TaskWaitpointResolveRequest } from '../gateway/types.js';
import type { WaitpointTokenClaims } from './waitpoint-token.js';

export interface WaitpointCapabilityClient {
  getTaskWaitpoint(id: string, ownerId: string): Promise<TaskWaitpoint>;
  resolveTaskWaitpoint(id: string, ownerId: string, request: TaskWaitpointResolveRequest): Promise<TaskWaitpoint>;
}

/** Single-purpose endpoint for email approval links and provider webhooks. */
export function createWaitpointCapabilityHandler(options: {
  tasks: WaitpointCapabilityClient;
  verify(token: string, action: 'resolve'): Promise<WaitpointTokenClaims>;
}): (request: Request) => Promise<Response> {
  if (!options?.tasks || typeof options.verify !== 'function') throw new TypeError('waitpoint client and token verifier are required');
  return async request => {
    try {
      if (request.method !== 'POST') return Response.json({ code: 'RHINOQ_METHOD_NOT_ALLOWED' }, { status: 405 });
      const authorization = request.headers.get('authorization') ?? '';
      if (!authorization.startsWith('Bearer ')) return Response.json({ code: 'RHINOQ_UNAUTHORIZED' }, { status: 401 });
      const claims = await options.verify(authorization.slice(7).trim(), 'resolve');
      const current = await options.tasks.getTaskWaitpoint(claims.waitpointId, claims.ownerId);
      if (current.taskId !== claims.taskId) return Response.json({ code: 'RHINOQ_WAITPOINT_NOT_FOUND' }, { status: 404 });
      const body = await request.json() as { expectedVersion?: unknown; resolution?: unknown; actor?: unknown };
      if (!Number.isInteger(body.expectedVersion) || Number(body.expectedVersion) <= 0 || body.resolution === undefined) {
        return Response.json({ code: 'RHINOQ_INVALID_REQUEST' }, { status: 400 });
      }
      return Response.json(await options.tasks.resolveTaskWaitpoint(current.id, claims.ownerId, {
        expectedVersion: Number(body.expectedVersion), resolutionId: claims.nonce,
        actor: typeof body.actor === 'string' && body.actor.trim() ? body.actor.trim() : `capability:${claims.nonce}`,
        resolution: body.resolution,
      }));
    } catch (error) {
      if (error instanceof RhinoQError) return Response.json({ code: error.code, message: error.message }, { status: error.status ?? 500 });
      return Response.json({ code: 'RHINOQ_INVALID_CAPABILITY', message: error instanceof Error ? error.message : 'Invalid waitpoint capability' }, { status: 401 });
    }
  };
}
