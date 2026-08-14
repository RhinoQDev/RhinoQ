import assert from 'node:assert/strict';
import test from 'node:test';

import { compileRhinoQBuildProfile } from '../dist/index.js';

test('build profile selects namespaced modules deterministically and reports lock limits', () => {
  const input = {
    name: 'media-worker',
    modules: [
      { id: 'storage/s3', namespace: 'storage', version: '1.2.0', checksum: 'sha256:0123456789abcdef0123456789abcdef' },
      { id: 'processor/ffmpeg', namespace: 'processor', version: '1.0.0' },
    ],
  };
  const first = compileRhinoQBuildProfile(input);
  const second = compileRhinoQBuildProfile({ ...input, modules: [...input.modules].reverse() });
  assert.equal(first.fingerprint, second.fingerprint);
  assert.deepEqual(first.modules.map((module) => module.id), ['processor/ffmpeg', 'storage/s3']);
  assert.equal(first.selectedOnly, true);
  assert.match(first.limitations[0], /checksum/);
});

test('build profile refuses duplicate or namespace-mismatched modules', () => {
  assert.throws(() => compileRhinoQBuildProfile({ name: 'bad', modules: [{ id: 'processor/ffmpeg', namespace: 'storage', version: '1' }] }), /namespace/);
  assert.throws(() => compileRhinoQBuildProfile({ name: 'bad', modules: [
    { id: 'processor/ffmpeg', namespace: 'processor', version: '1' },
    { id: 'processor/ffmpeg', namespace: 'processor', version: '1' },
  ] }), /select a module twice/);
});
