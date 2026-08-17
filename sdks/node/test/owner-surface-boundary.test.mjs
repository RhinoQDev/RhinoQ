import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

// `PostgresTaskClient` carries two boundaries in one class. Most of it is
// owner-scoped; a few methods are runtime/adapter primitives that read or write
// by bare identity with no tenant predicate at all. Each is marked "must not be
// mounted as an owner-facing endpoint" in a comment, and a comment does not
// stop anyone: mounting one behind an owner token would be an IDOR reachable by
// any authenticated caller who can guess or obtain an execution id.
//
// `OwnerFacingTaskStore` is the enforced version of that comment. This test
// guards the list itself, because the failure it prevents is someone widening
// the type to make a build error go away.
const source = await readFile(new URL('../src/tasks/http.ts', import.meta.url), 'utf8');

const UNSCOPED = [
  'getTaskExecution',
  'transitionTaskExecution',
  'lookupTaskExecution',
  'attachTaskExecutionResult',
  'bindTaskExecution',
  'createTaskExecution',
  'retryTaskExecution',
  'transitionTask',
  'reportTaskProgress',
  'attachTaskResult',
  'resolveTaskCancellation',
];

function ownerSurfaceEntries() {
  const block = source.match(/export type OwnerFacingTaskStore = Pick<[\s\S]*?>;/);
  assert.ok(block, 'OwnerFacingTaskStore must remain a Pick over the client');
  return [...block[0].matchAll(/'([A-Za-z]+)'/g)].map((match) => match[1]);
}

test('the owner HTTP surface cannot reach an unscoped runtime method', () => {
  const permitted = ownerSurfaceEntries();
  const leaked = UNSCOPED.filter((name) => permitted.includes(name));
  assert.deepEqual(
    leaked, [],
    `OwnerFacingTaskStore lists ${leaked.join(', ')}, which carries no tenant predicate. `
    + 'Route it through a *ForOwner method instead of widening this type.',
  );
});

test('the owner HTTP surface is a Pick, not the whole client', () => {
  assert.match(
    source,
    /tasks: OwnerFacingTaskStore;/,
    'TaskRequestHandlerOptions.tasks must be the narrowed surface, not PostgresTaskClient',
  );
  assert.doesNotMatch(
    source,
    /tasks: PostgresTaskClient;/,
    'typing the option as the concrete client puts every unscoped method back in reach',
  );
});

// Every entry must be either explicitly owner-scoped by name, or one of the
// three whose handler establishes ownership before calling it. Anything else is
// a method whose fence nobody has checked.
test('every permitted method is owner-scoped by name or by a checked exception', () => {
  const FENCED_IN_THE_ROUTE = new Set([
    'createTaskWaitpoint',
    'getTaskWaitpoint',
    'refreshTaskArtifact',
    'resolveTaskWaitpoint',
    'listTasks',
    'listTasksPage',
    'listTasksByState',
  ]);
  const unexplained = ownerSurfaceEntries()
    .filter((name) => !name.endsWith('ForOwner') && !FENCED_IN_THE_ROUTE.has(name));
  assert.deepEqual(
    unexplained, [],
    `${unexplained.join(', ')} is neither a *ForOwner method nor a documented exception. `
    + 'Confirm where its tenant fence is, then add it to the exception list with that reason.',
  );
});
