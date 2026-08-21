import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// This is an offline, clean-directory smoke test. It deliberately uses the
// built CLI rather than npm/network services so it can run on Windows and
// Linux in a release job without inventing production evidence.
const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const cli = join(root, 'sdks', 'node', 'dist', 'cli', 'rhinoq.js');
if (!existsSync(cli)) throw new Error(`missing built CLI: ${cli}; run npm run build in sdks/node first`);

const cwd = mkdtempSync(join(tmpdir(), 'rhinoq-first-value-'));
const run = (args) => {
  const result = spawnSync(process.execPath, [cli, ...args], { cwd, encoding: 'utf8', env: {} });
  assert.equal(result.status, 0, `${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
};

try {
  const connect = run(['connect']);
  assert.match(connect, /nothing is written/i);

  const preview = run(['add', 'task', 'report.export']);
  assert.match(preview, /smoke test/i);
  run(['add', 'task', 'report.export', '--apply']);
  assert.match(readFileSync(join(cwd, 'src', 'rhinoq.tasks.mjs'), 'utf8'), /context\.progress\(1, 1/);
  assert.match(readFileSync(join(cwd, 'test', 'rhinoq.tasks.test.mjs'), 'utf8'), /plan\.status/);

  run(['doctor', '--fix']);
  assert.match(readFileSync(join(cwd, '.rhinoq', 'config.json'), 'utf8'), /taskProfileVersion/);

  run(['up', '--dry-run', '--db-port=55439']);
  assert.match(readFileSync(join(cwd, '.rhinoq', 'compose.local.yml'), 'utf8'), /postgres:16-alpine/);
  assert.match(readFileSync(join(cwd, '.env.rhinoq.local'), 'utf8'), /55439/);
} finally {
  rmSync(cwd, { recursive: true, force: true });
}

const demoCwd = mkdtempSync(join(tmpdir(), 'rhinoq-first-value-demo-'));
const child = spawn(process.execPath, [cli, 'dev', '--demo', '--port=0'], {
  cwd: demoCwd,
  env: { ...process.env },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let output = '';
let error = '';
child.stdout.on('data', (chunk) => { output += chunk; });
child.stderr.on('data', (chunk) => { error += chunk; });
try {
  const url = await new Promise((resolveURL, reject) => {
    const timer = setTimeout(() => reject(new Error(`demo did not start\n${output}\n${error}`)), 10_000);
    const check = () => {
      const match = output.match(/URL RhinoQ Workbench: (http:\/\/127\.0\.0\.1:\d+\/rhinoq)/);
      if (!match) return;
      clearTimeout(timer);
      resolveURL(match[1]);
    };
    child.stdout.on('data', check);
    check();
  });
  const response = await fetch(`${url}/api/overview`);
  assert.equal(response.status, 200);
  const overview = await response.json();
  assert.equal(overview.counts.running, 1);
  assert.equal(overview.actions, true);
} finally {
  child.kill();
  await new Promise((resolveClose) => child.once('close', resolveClose));
  rmSync(demoCwd, { recursive: true, force: true });
}

console.log('PASS first-value clean-room smoke: connect, add task, doctor, up --dry-run and dev --demo');
