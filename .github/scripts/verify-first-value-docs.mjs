import { readFile } from 'node:fs/promises';

const root = new URL('../../', import.meta.url);
const read = (path) => readFile(new URL(path, root), 'utf8');
const sources = {
  'README.md': await read('README.md'),
  'docs/quickstart.md': await read('docs/quickstart.md'),
  'docs/cli.md': await read('docs/cli.md'),
  'docs/task-run-handle.md': await read('docs/task-run-handle.md'),
  'docs/integration-eraser.md': await read('docs/integration-eraser.md'),
};

const required = [
  ['README.md', 'npx rhinoq dev --demo'],
  ['README.md', 'npx rhinoq up'],
  ['README.md', 'npx rhinoq connect'],
  ['README.md', 'npx rhinoq add task report.export'],
  ['docs/quickstart.md', 'npx rhinoq up --dry-run'],
  ['docs/cli.md', 'npx rhinoq doctor --fix'],
  ['docs/integration-eraser.md', '.rhinoqignore'],
  ['docs/task-run-handle.md', 'TaskRunHandle'],
  ['docs/cli.md', 'verify:first-value'],
];
for (const [path, marker] of required) {
  if (!sources[path].includes(marker)) throw new Error(`${path} is missing first-value marker ${JSON.stringify(marker)}`);
}

for (const [path, contents] of Object.entries(sources)) {
  for (const stale of ['create-rhinoq-app@next', '0.1.0-beta.20', 'postgres:17-alpine']) {
    if (contents.includes(stale)) throw new Error(`${path} still contains stale first-run claim ${JSON.stringify(stale)}`);
  }
}

console.log('PASS first-value documentation markers and stale-claim checks');
