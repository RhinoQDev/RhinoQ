import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PACKAGE_ROOT } from './source-hash.mjs';

const matrix = JSON.parse(await readFile(join(PACKAGE_ROOT, 'contracts', 'fault-matrix.json'), 'utf8'));
if (matrix.schemaVersion !== 1 || !Array.isArray(matrix.scenarios) || matrix.scenarios.length < 15) {
  throw new Error('fault matrix must contain at least 15 versioned scenarios');
}
const ids = new Set();
for (const scenario of matrix.scenarios) {
  if (!scenario.id?.trim() || ids.has(scenario.id)) throw new Error(`invalid or duplicate fault scenario ${scenario.id}`);
  ids.add(scenario.id);
  const source = await readFile(join(PACKAGE_ROOT, scenario.file), 'utf8');
  if (!source.includes(scenario.marker)) throw new Error(`${scenario.id} evidence marker is missing from ${scenario.file}`);
}
console.log(`PASS fault matrix ${matrix.scenarios.length} scenarios`);
