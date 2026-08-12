import { readFile } from 'node:fs/promises';

const root = new URL('../../', import.meta.url);
const read = (path) => readFile(new URL(path, root), 'utf8');
const json = async (path) => JSON.parse(await read(path));
const [matrix, workflow, goMod, fanoutPackage] = await Promise.all([
  read('docs/compatibility-matrix.md'), read('.github/workflows/ci.yml'), read('go.mod'),
  json('examples/fanout-bullmq/package.json'),
]);
const bullmq = fanoutPackage.dependencies?.bullmq;
const redis = workflow.match(/image: redis:(\d+)-alpine/)?.[1];
const postgres = workflow.match(/image: postgres:(\d+)-alpine/)?.[1];
const toolchain = goMod.match(/^toolchain go([\d.]+)$/m)?.[1];
const required = [
  ['Node.js', workflow.includes('node-version: [22, 24]') && matrix.includes('| Node.js | 22, 24 |')],
  ['PostgreSQL', postgres && matrix.includes(`| PostgreSQL | ${postgres} |`)],
  ['Redis', redis && matrix.includes(`| Redis | ${redis} |`)],
  ['BullMQ', /^\d+\.\d+\.\d+$/.test(bullmq ?? '') && matrix.includes(`| BullMQ | ${bullmq} |`)],
  ['Go toolchain', toolchain && matrix.includes(`| Go | ${toolchain} toolchain |`)],
];
for (const [name, valid] of required) if (!valid) throw new Error(`${name} compatibility marker drifted from executable configuration`);
console.log(`PASS compatibility matrix: Node 22/24, PostgreSQL ${postgres}, Redis ${redis}, BullMQ ${bullmq}, Go ${toolchain}`);
