import assert from 'node:assert/strict';
import test from 'node:test';

import { linkRhinoQCapabilities } from '../dist/index.js';

test('typed capability linking is deterministic and exposes references without secret values', () => {
  const components = [
    {
      id: 'storage/s3', version: 1, contractVersion: 1,
      provides: ['storage:artifacts'],
      binding: {
        properties: { region: 'ap-southeast-1', checksum: true },
        secrets: { credential: { ref: 'secret://aws/rhinoq' } },
        permissions: ['s3:PutObject', 's3:GetObject'],
      },
    },
    {
      id: 'provider/mail', version: 1, contractVersion: 1,
      provides: ['provider:mail'], requires: ['storage:artifacts'],
    },
  ];
  const requirements = [
    { capability: 'provider:mail', requiredBy: 'task:report.export' },
    { capability: 'storage:artifacts', requiredBy: 'task:report.export' },
  ];
  const first = linkRhinoQCapabilities({ components, requirements });
  const second = linkRhinoQCapabilities({ components: [...components].reverse(), requirements: [...requirements].reverse() });
  assert.equal(first.fingerprint, second.fingerprint);
  assert.deepEqual(first.links.map((link) => link.capability), ['provider:mail', 'storage:artifacts']);
  assert.deepEqual(first.links[1].binding.secretRefs, ['secret://aws/rhinoq']);
  assert.equal(JSON.stringify(first).includes('credential-value'), false);
  assert.ok(Object.isFrozen(first));
  assert.ok(Object.isFrozen(first.links));
});

test('capability linking fails closed for missing or ambiguous providers', () => {
  assert.throws(() => linkRhinoQCapabilities({
    components: [], requirements: [{ capability: 'provider:mail', requiredBy: 'task:notify' }],
  }), /has no provider/);
  const provider = (id) => ({ id, version: 1, contractVersion: 1, provides: ['provider:mail'] });
  assert.throws(() => linkRhinoQCapabilities({
    components: [provider('provider/mail-a'), provider('provider/mail-b')],
    requirements: [{ capability: 'provider:mail', requiredBy: 'task:notify' }],
  }), /multiple providers/);
});

test('optional capability gaps remain explicit instead of being invented', () => {
  const graph = linkRhinoQCapabilities({
    components: [],
    requirements: [{ capability: 'surface:realtime', requiredBy: 'task:report.export', optional: true }],
  });
  assert.equal(graph.links.length, 0);
  assert.deepEqual(graph.unresolvedOptional, [{ capability: 'surface:realtime', requiredBy: 'task:report.export', optional: true }]);
});

test('component-to-component requirements also require exactly one provider', () => {
  const mail = { id: 'provider/mail', version: 1, contractVersion: 1, provides: ['provider:mail'], requires: ['storage:artifacts'] };
  const storage = (id) => ({ id, version: 1, contractVersion: 1, provides: ['storage:artifacts'] });
  assert.throws(() => linkRhinoQCapabilities({ components: [mail], requirements: [] }), /requires missing capability/);
  assert.throws(() => linkRhinoQCapabilities({ components: [mail, storage('storage/a'), storage('storage/b')], requirements: [] }), /requires ambiguous capability/);
});
