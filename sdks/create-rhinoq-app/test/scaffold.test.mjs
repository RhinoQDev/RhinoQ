import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const cli = join(import.meta.dirname, '..', 'index.mjs');

async function scaffold(name = 'demo') {
  const root = await mkdtemp(join(tmpdir(), 'rhinoq-scaffold-'));
  const target = join(root, name);
  execFileSync(process.execPath, [cli, target, '--no-install'], { stdio: 'pipe' });
  return { root, target };
}

test('writes a runnable project, with the files npm cannot publish under their real names', async () => {
  const { root, target } = await scaffold();
  try {
    const files = (await readdir(target)).sort();
    assert.deepEqual(files, [
      '.env', '.gitignore', 'README.md', 'docker-compose.yml',
      'package.json', 'server.mjs', 'start.mjs', 'ui.mjs', 'verify.mjs',
    ]);
    // `_package.json` and `_gitignore` in the template must not survive: npm
    // will not publish a real .gitignore inside a package, and a nested
    // package.json confuses tooling that walks the tree.
    assert.equal(files.includes('_package.json'), false);

    const manifest = JSON.parse(await readFile(join(target, 'package.json'), 'utf8'));
    assert.equal(manifest.name, 'demo');
    assert.ok(manifest.dependencies['@rhinoq/node']);
    assert.equal(manifest.scripts.start, 'node start.mjs');

    const server = await readFile(join(target, 'server.mjs'), 'utf8');
    const ui = await readFile(join(target, 'ui.mjs'), 'utf8');
    const readme = await readFile(join(target, 'README.md'), 'utf8');
    assert.match(server, /app\.http\(\{/);
    assert.match(server, /workbenchPath: '\/operator-login'/);
    assert.doesNotMatch(server, /server\.use\('\/tasks', app\.routes\(\)\)/);
    assert.match(ui, /Async operations overview/);
    assert.match(ui, /Needs attention/);
    assert.match(ui, /Recent tasks/);
    assert.match(ui, /View task/);
    assert.match(ui, /overviewGuidance/);
    assert.match(ui, /\/task-center/);
    assert.match(ui, /\/operator-login/);
    assert.doesNotMatch(ui, /\$\{operatorToken\}/);
    assert.doesNotMatch(ui, /let-me-in/);
    assert.doesNotMatch(ui, /<a[^>]*><button/);
    assert.doesNotMatch(ui, /target="_blank"/);
    assert.match(server, /server\.get\('\/overview'.*redirect\(302, '\/'\)/);
    assert.match(server, /HttpOnly; SameSite=Strict; Path=\/admin/);
    assert.match(server, /listen\(PORT, '127\.0\.0\.1'/);
    assert.match(server, /defaultJobOptions: \{ attempts: 2/);
    assert.match(readme, /one middleware/i);
    const generatedUI = await import(`${pathToFileURL(join(target, 'ui.mjs')).href}?test=${Date.now()}`);
    const home = generatedUI.page();
    const script = home.match(/<script>([\s\S]*)<\/script>/)?.[1];
    assert.ok(script, 'generated Overview needs its application script');
    assert.doesNotThrow(() => new Function(script));
    assert.match(generatedUI.operatorLoginPage(), /href="\/task-center"/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// The default 5432 collides with the PostgreSQL the developer already runs, and
// the collision surfaces as an authentication failure against someone else's
// database — a genuinely bad first five minutes.
test('the generated ports are free, and .env and compose agree on them', async () => {
  const { root, target } = await scaffold();
  try {
    const env = await readFile(join(target, '.env'), 'utf8');
    const compose = await readFile(join(target, 'docker-compose.yml'), 'utf8');
    const pgPort = /127\.0\.0\.1:(\d+)\/rhinoq/.exec(env)?.[1];
    const redisPort = /redis:\/\/127\.0\.0\.1:(\d+)/.exec(env)?.[1];
    assert.ok(pgPort && redisPort, '.env must name both ports');
    assert.match(compose, new RegExp(`'${pgPort}:5432'`));
    assert.match(compose, new RegExp(`'${redisPort}:6379'`));
    assert.notEqual(pgPort, redisPort);
    assert.equal(compose.includes('__PGPORT__'), false, 'every placeholder is substituted');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('refuses to write into a directory that already has something in it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rhinoq-scaffold-'));
  const target = join(root, 'occupied');
  await mkdir(target, { recursive: true });
  await writeFile(join(target, 'keep.txt'), 'mine\n');
  try {
    assert.throws(() => execFileSync(process.execPath, [cli, target, '--no-install'], { stdio: 'pipe' }));
    assert.equal(await readFile(join(target, 'keep.txt'), 'utf8'), 'mine\n');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('--sdk redirects the dependency at a local build', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rhinoq-scaffold-'));
  const target = join(root, 'linked');
  try {
    execFileSync(process.execPath, [cli, target, '--no-install', '--sdk', 'file:../../sdks/node'], {
      stdio: 'pipe',
    });
    const manifest = JSON.parse(await readFile(join(target, 'package.json'), 'utf8'));
    assert.equal(manifest.dependencies['@rhinoq/node'], 'file:../../sdks/node');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
