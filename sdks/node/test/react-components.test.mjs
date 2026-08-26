import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRhinoQComponents } from '../dist/react-entry.js';

function element(type, props, ...children) { return { type, props: props ?? {}, children }; }
const react = {
  createElement: element,
  useMemo(factory) { return factory(); },
  useEffect() {},
  useSyncExternalStore(_subscribe, getSnapshot) { return getSnapshot(); },
};

test('embeddable progress exposes accessible native progress and theme tokens', () => {
  const { RhinoQProgress } = createRhinoQComponents(react);
  const tree = RhinoQProgress({
    task: { schemaVersion: 1, entityVersion: 2, id: 'one', type: 'report.export', state: 'running',
      progress: { completed: 2, total: 4 }, hasResult: false, executions: [],
      createdAt: '2026-08-12T00:00:00Z', updatedAt: '2026-08-12T00:00:00Z' },
    theme: { accent: '#123456', radius: '4px' },
  });
  assert.equal(tree.props.style['--rq-accent'], '#123456');
  assert.equal(tree.props.style['--rq-radius'], '4px');
  assert.equal(tree.children[0].type, 'style');
  assert.match(tree.children[0].children[0], /prefers-reduced-motion/);
  assert.match(tree.children[0].children[0], /rhinoq-progress-fill/);
  assert.match(tree.children[0].children[0], /Compact workspace defaults/);
  assert.equal(tree.children[4].type, 'progress');
  assert.equal(tree.children[4].props.value, 50);
  assert.match(tree.children[4].props['aria-label'], /2 of 4/);
});

test('embeddable list and detail render explicit loading states', () => {
  const { RhinoQTaskList, RhinoQTaskDetail } = createRhinoQComponents(react);
  const list = RhinoQTaskList({ client: { async listTasks() { return []; } } });
  assert.equal(list.props['aria-busy'], true);
  assert.equal(list.children[0].type, 'style');
  assert.equal(list.children[1].children[1].props.role, 'status');
  assert.match(list.children[0].children[0], /rhinoq-skeleton-card/);
  const detail = RhinoQTaskDetail({
    client: { async getTask() {}, async cancelTask() {}, async getTaskResult() {} }, taskId: 'one',
  });
  assert.equal(detail.props['aria-busy'], true);
  assert.equal(detail.children[0].type, 'style');
  assert.equal(detail.children[1].props.role, 'status');
});

test('RhinoQTaskCenter provides a complete owner-facing workspace from an API URL', () => {
  const { RhinoQTaskCenter } = createRhinoQComponents(react);
  const tree = RhinoQTaskCenter({
    apiUrl: '/api/rhinoq/tasks',
    currentUser: { name: 'Mai Nguyen' },
    title: 'Background work',
    retryCommandId: (task) => `${task.id}-retry-${task.entityVersion}`,
    savedFilters: [{ id: 'attention', label: 'Needs review', filter: 'attention' }],
  });
  assert.equal(tree.type, 'section');
  assert.match(tree.props.className, /rhinoq-center/);
  assert.match(tree.children[0].children[0], /rhinoq-drawer/);
  assert.match(tree.children[0].children[0], /rhinoq-toast/);
  assert.equal(findText(tree, 'Background work'), true);
  assert.equal(findText(tree, 'Mai Nguyen'), true);
  assert.equal(findByProp(tree, 'aria-label', 'Search tasks')?.type, 'input');
  assert.equal(findByProp(tree, 'aria-label', 'Saved task view')?.type, 'select');
  assert.match(tree.children[0].children[0], /has-saved-filters/);
  assert.equal(findByProp(tree, 'aria-label', 'Task overview')?.children.length, 4);
  assert.equal(findByProp(tree, 'aria-label', 'Task notifications')?.props['aria-live'], 'polite');
});

test('RhinoQTaskCenter refuses to imply browser identity without an owner API', () => {
  const { RhinoQTaskCenter } = createRhinoQComponents(react);
  assert.throws(() => RhinoQTaskCenter({ currentUser: { name: 'Display only' } }), /requires client or apiUrl/);
});

test('RhinoQTaskCenter validates and exposes compact large-list controls', () => {
  const { RhinoQTaskCenter } = createRhinoQComponents(react);
  const tree = RhinoQTaskCenter({
    apiUrl: '/api/rhinoq/tasks',
    display: { density: 'compact', pageSize: 10, maxListHeight: 420, showMetrics: false },
    taskLabel: (task) => `Video ${task.id}`,
  });
  assert.equal(tree.props['data-density'], 'compact');
  assert.equal(findByProp(tree, 'aria-label', 'Task overview'), undefined);
  assert.match(tree.children[0].children[0], /rhinoq-center-list-scroll/);
  assert.match(tree.children[0].children[0], /data-density="compact"/);
  assert.throws(() => RhinoQTaskCenter({ apiUrl: '/api/rhinoq/tasks', display: { pageSize: 0 } }), /pageSize must be 1\.\.100/);
  assert.throws(() => RhinoQTaskCenter({ apiUrl: '/api/rhinoq/tasks', display: { maxListHeight: '' } }), /maxListHeight must not be empty/);
});

function findText(value, expected) {
  if (value === expected) return true;
  if (!value || typeof value !== 'object') return false;
  return (value.children ?? []).some((child) => findText(child, expected));
}

function findByProp(value, name, expected) {
  if (!value || typeof value !== 'object') return undefined;
  if (value.props?.[name] === expected) return value;
  for (const child of value.children ?? []) {
    const found = findByProp(child, name, expected);
    if (found) return found;
  }
  return undefined;
}
