// The package is "type": "module", so every .js file it ships is ESM unless a
// nearer package.json says otherwise. This drops that marker next to the
// CommonJS emit; without it Node reads dist/cjs/index.js as ESM and a
// `require('@rhinoq/node')` from a CommonJS application fails.
import { mkdir, writeFile } from 'node:fs/promises';

const directory = new URL('../dist/cjs/', import.meta.url);
await mkdir(directory, { recursive: true });
await writeFile(
  new URL('package.json', directory),
  `${JSON.stringify({ type: 'commonjs' }, null, 2)}\n`,
);
