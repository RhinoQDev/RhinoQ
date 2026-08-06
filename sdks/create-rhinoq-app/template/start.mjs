// `npm start` is one command because the alternative is six, and the sixth is
// the only one anybody wanted to run.
//
// Brings up PostgreSQL and Redis, waits for them, applies the schema, starts
// the app and opens a browser at a batch that is already running.
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import net from 'node:net';
import process from 'node:process';

// Node refuses to spawn a .cmd shim without a shell since the 2024
// command-injection fix, and both npm and Docker Desktop are .cmd shims here.
const onWindows = process.platform === 'win32';

const env = { ...readEnvFile('.env'), ...process.env };
const databaseUrl = env.RHINOQ_DATABASE_URL;
const redisUrl = env.REDIS_URL;
const port = Number(env.PORT ?? 3000);

if (usesLocalDocker(databaseUrl)) {
  if (!hasDocker()) {
    exit(
      'Docker is not on PATH, and .env points at a database on localhost that nothing is serving.\n' +
      'Either start Docker, or set RHINOQ_DATABASE_URL and REDIS_URL in .env to a PostgreSQL\n' +
      'and Redis you already run.',
    );
  }
  process.stdout.write('Starting PostgreSQL and Redis…\n');
  run('docker', ['compose', 'up', '-d', '--wait']);
}

await waitForPort(portOf(databaseUrl, 5432), 'PostgreSQL');
await waitForPort(portOf(redisUrl, 6379), 'Redis');

process.stdout.write('Applying the RhinoQ Task schema…\n');
run(npm(), ['exec', '--', 'rhinoq-task'], { RHINOQ_DATABASE_URL: databaseUrl });

const server = spawn(process.execPath, ['--env-file=.env', 'server.mjs'], {
  stdio: 'inherit',
  env: { ...env, RHINOQ_SEED_BATCH: env.RHINOQ_SEED_BATCH ?? '50' },
});
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => { server.kill(signal); });
}
server.on('exit', (code) => process.exit(code ?? 0));

await waitForPort(port, 'the app');
open(`http://localhost:${port}`);

function readEnvFile(path) {
  try {
    return Object.fromEntries(
      readFileSync(path, 'utf8')
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith('#'))
        .map((line) => {
          const index = line.indexOf('=');
          return [line.slice(0, index), line.slice(index + 1)];
        }),
    );
  } catch {
    return {};
  }
}

function usesLocalDocker(url) {
  return !url || /(?:127\.0\.0\.1|localhost)/.test(url);
}

function portOf(url, fallback) {
  const match = /:(\d+)(?:\/|$)/.exec(url ?? '');
  return match ? Number(match[1]) : fallback;
}

function hasDocker() {
  return spawnSync('docker', ['--version'], { stdio: 'ignore', shell: onWindows }).status === 0;
}

function npm() {
  return 'npm';
}

function run(command, args, extraEnv = {}) {
  const result = spawnSync(command, args, {
    stdio: 'inherit',
    shell: onWindows,
    env: { ...process.env, ...env, ...extraEnv },
  });
  if (result.status !== 0) {
    exit(`${command} ${args.join(' ')} failed.`);
  }
}

async function waitForPort(port, label) {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (await reachable(port)) return;
    await sleep(300);
  }
  exit(`${label} did not come up on port ${port} within 90 seconds.`);
}

function reachable(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: '127.0.0.1' });
    socket.setTimeout(1_000);
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', () => { socket.destroy(); resolve(false); });
    socket.once('timeout', () => { socket.destroy(); resolve(false); });
  });
}

function open(url) {
  const command = process.platform === 'darwin' ? ['open', [url]]
    : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
      : ['xdg-open', [url]];
  spawn(command[0], command[1], { stdio: 'ignore', detached: true }).unref();
}

function exit(message) {
  process.stderr.write(`\n${message}\n`);
  process.exit(1);
}
