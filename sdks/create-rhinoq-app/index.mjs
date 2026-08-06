#!/usr/bin/env node
// Scaffolds a running fan-out, not a tutorial.
//
// The thing being fixed here is that the shortest path into RhinoQ used to be
// six commands and a PostgreSQL you had to have already. Nobody stands up a
// database to evaluate a library at eleven at night. This writes an app that
// brings its own database, migrates it, runs a batch and opens the console.
import { cp, mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { basename, join, resolve } from 'node:path';
import process from 'node:process';

const USAGE = `Usage:
  npx create-rhinoq-app <directory>

Options:
  --no-install   write the files and stop
  --sdk <spec>   @rhinoq/node version or path (default: the matching release)
`;

const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
  process.stdout.write(USAGE);
  process.exit(0);
}

const target = resolve(args.find((value) => !value.startsWith('--')) ?? 'rhinoq-app');
const install = !args.includes('--no-install');
const sdkIndex = args.indexOf('--sdk');
const sdkSpec = sdkIndex >= 0 ? args[sdkIndex + 1] : undefined;
const name = basename(target).replace(/[^a-z0-9-]+/gi, '-').toLowerCase() || 'rhinoq-app';

if (existsSync(target) && (await readdir(target)).length > 0) {
  fail(`${target} already exists and is not empty.`);
}

const templateDir = join(import.meta.dirname, 'template');
await mkdir(target, { recursive: true });
await cp(templateDir, target, { recursive: true });

// Files npm refuses to publish under their real names inside a package.
for (const [from, to] of [['_package.json', 'package.json'], ['_gitignore', '.gitignore']]) {
  await rename(join(target, from), join(target, to));
}

const packageJsonPath = join(target, 'package.json');
const manifest = JSON.parse(await readFile(packageJsonPath, 'utf8'));
manifest.name = name;
if (sdkSpec) manifest.dependencies['@rhinoq/node'] = sdkSpec;
await writeFile(packageJsonPath, `${JSON.stringify(manifest, null, 2)}\n`);

// A port collision is the one setup failure that produces a confusing error
// several minutes later, so it is resolved now, before anything is installed.
const ports = await freePorts();
const composePath = join(target, 'docker-compose.yml');
await writeFile(
  composePath,
  (await readFile(composePath, 'utf8'))
    .replaceAll('__PGPORT__', String(ports.postgres))
    .replaceAll('__REDISPORT__', String(ports.redis))
    .replaceAll('__NAME__', name),
);
const envPath = join(target, '.env');
await writeFile(
  envPath,
  [
    `RHINOQ_DATABASE_URL=postgres://rhinoq:rhinoq@127.0.0.1:${ports.postgres}/rhinoq`,
    `REDIS_URL=redis://127.0.0.1:${ports.redis}`,
    'OPERATOR_TOKEN=let-me-in',
    'PORT=3000',
    '',
  ].join('\n'),
);

process.stdout.write(`Created ${target}\n`);

if (install) {
  process.stdout.write('Installing dependencies…\n');
  const result = spawnSync(npmCommand(), ['install'], {
    cwd: target,
    stdio: 'inherit',
    // Node refuses to spawn a .cmd shim without a shell since the 2024
    // command-injection fix, and npm on Windows is a .cmd shim.
    shell: process.platform === 'win32',
  });
  if (result.status !== 0) {
    process.stdout.write('\nnpm install did not finish. Run it yourself, then npm start.\n');
    process.exitCode = 1;
  }
}

if (!hasDocker()) {
  process.stdout.write(
    '\nDocker was not found on PATH. `npm start` brings up PostgreSQL and Redis with\n' +
    'docker compose; without it, point RHINOQ_DATABASE_URL and REDIS_URL in .env at\n' +
    'your own and run `npm start` again.\n',
  );
}

process.stdout.write(`
Next:

  cd ${basename(target)}
  npm start

That starts PostgreSQL and Redis, applies the schema, runs a 50-item batch and
opens http://localhost:3000. The operator console is at /admin.
`);

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function npmCommand() {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

function hasDocker() {
  return spawnSync('docker', ['--version'], {
    stdio: 'ignore',
    shell: process.platform === 'win32',
  }).status === 0;
}

/**
 * Picks ports nothing is listening on.
 *
 * Defaulting to 5432 means the scaffold collides with the PostgreSQL the
 * developer already runs, and the failure surfaces as an authentication error
 * against the wrong database — which is a genuinely bad first five minutes.
 */
async function freePorts() {
  const { createServer } = await import('node:net');
  const pick = (start) => new Promise((resolvePort, rejectPort) => {
    const probe = createServer();
    probe.once('error', () => {
      probe.close();
      pick(start + 1).then(resolvePort, rejectPort);
    });
    // Deliberately not bound to 127.0.0.1: Docker publishes on 0.0.0.0, and on
    // some platforms a loopback-only probe succeeds against a port Docker has
    // already taken. The collision then surfaces as an authentication failure
    // against somebody else's database.
    probe.listen(start, () => {
      probe.close(() => resolvePort(start));
    });
  });
  return { postgres: await pick(55432), redis: await pick(56379) };
}
