const imports = new Map();

export function createImportTask({ ownerId, total }) {
  const id = `import_${imports.size + 1}`;
  const task = {
    id,
    ownerId,
    state: 'queued',
    completed: 0,
    total,
    result: null,
    cancelled: false,
  };
  imports.set(id, task);
  return structuredClone(task);
}

export function readImportTask(id, ownerId) {
  const task = imports.get(id);
  if (!task || task.ownerId !== ownerId) return null;
  return structuredClone(task);
}

export function updateImportProgress(id, ownerId, completed) {
  const task = imports.get(id);
  if (!task || task.ownerId !== ownerId) return null;
  task.state = completed >= task.total ? 'succeeded' : 'running';
  task.completed = Math.min(completed, task.total);
  return structuredClone(task);
}

export function cancelImportTask(id, ownerId) {
  const task = imports.get(id);
  if (!task || task.ownerId !== ownerId) return null;
  task.cancelled = true;
  task.state = 'cancelled';
  return structuredClone(task);
}

export function attachImportResult(id, ownerId, result) {
  const task = imports.get(id);
  if (!task || task.ownerId !== ownerId) return null;
  task.result = result;
  return structuredClone(task);
}
