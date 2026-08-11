export async function createImportTask(tasks, { id, ownerId, tenantId, total }) {
  let task = await tasks.createTask({
    id,
    type: 'media.import',
    ownerId,
    tenantId,
    definitionVersion: 1,
  });
  task = await tasks.transitionTask(task.id, task.entityVersion, 'queued');
  return tasks.transitionTask(task.id, task.entityVersion, 'running');
}

export async function updateImportProgress(tasks, task, completed, total = task.progress.total) {
  return tasks.reportTaskProgress(task.id, task.entityVersion, {
    completed,
    total,
    message: completed >= (total ?? 0) ? 'Import complete' : 'Importing media',
  });
}

export async function cancelImportTask(tasks, task) {
  return tasks.requestTaskCancellation(task.id, task.entityVersion);
}
