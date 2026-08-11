import {
  attachImportResult,
  cancelImportTask,
  createImportTask,
  readImportTask,
  updateImportProgress,
} from './import-service.mjs';

export async function handleRequest(request, ownerId) {
  const url = new URL(request.url);
  const match = url.pathname.match(/^\/api\/imports(?:\/([^/]+))?(?:\/(cancel|result))?$/);
  if (!match) return new Response('Not found', { status: 404 });
  const id = match[1];
  const action = match[2];
  if (request.method === 'POST' && !id) {
    const body = await request.json();
    return Response.json(createImportTask({ ownerId, total: body.total }));
  }
  if (!id) return new Response('Method not allowed', { status: 405 });
  if (request.method === 'GET' && !action) {
    const task = readImportTask(id, ownerId);
    return task ? Response.json(task) : new Response('Not found', { status: 404 });
  }
  if (request.method === 'POST' && action === 'cancel') {
    const task = cancelImportTask(id, ownerId);
    return task ? Response.json(task) : new Response('Not found', { status: 404 });
  }
  if (request.method === 'POST' && action === 'result') {
    const body = await request.json();
    const task = attachImportResult(id, ownerId, body.result);
    return task ? Response.json(task) : new Response('Not found', { status: 404 });
  }
  return new Response('Method not allowed', { status: 405 });
}

export function reportProgress(id, ownerId, completed) {
  return updateImportProgress(id, ownerId, completed);
}
