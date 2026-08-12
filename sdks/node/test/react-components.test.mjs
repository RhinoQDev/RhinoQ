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
  assert.equal(tree.props.style['--rhinoq-accent'], '#123456');
  assert.equal(tree.props.style['--rhinoq-radius'], '4px');
  assert.equal(tree.children[1].type, 'progress');
  assert.equal(tree.children[1].props.value, 50);
  assert.match(tree.children[1].props['aria-label'], /2 of 4/);
});

test('embeddable list and detail render explicit loading states', () => {
  const { RhinoQTaskList, RhinoQTaskDetail } = createRhinoQComponents(react);
  const list = RhinoQTaskList({ client: { async listTasks() { return []; } } });
  assert.equal(list.props['aria-busy'], true);
  assert.equal(list.children[0].props.role, 'status');
  const detail = RhinoQTaskDetail({
    client: { async getTask() {}, async cancelTask() {}, async getTaskResult() {} }, taskId: 'one',
  });
  assert.equal(detail.props['aria-busy'], true);
  assert.equal(detail.children[0].props.role, 'status');
});
