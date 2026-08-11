import { createTaskRequestHandler } from '@rhinoq/node';

export function createHttpHandler(tasks) {
  return createTaskRequestHandler({
    tasks,
    ownerFromRequest: (request) => request.headers.get('x-owner'),
    tenantFromRequest: (request) => request.headers.get('x-tenant'),
    stream: false,
  });
}
