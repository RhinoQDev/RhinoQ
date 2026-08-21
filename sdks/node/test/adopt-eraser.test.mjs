import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const developerCLI = fileURLToPath(new URL('../dist/cli/rhinoq.js', import.meta.url));

test('adopt --scan reports bounded integration evidence without writing or deleting', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'rhinoq-eraser-'));
  try {
    mkdirSync(join(cwd, 'src'), { recursive: true });
    mkdirSync(join(cwd, 'node_modules', 'ignored'), { recursive: true });
    writeFileSync(join(cwd, 'src', 'status.ts'), `router.get('/tasks/:id/status', async (_req, res) => res.json(await readStatus()));\n`);
    writeFileSync(join(cwd, 'src', 'polling.ts'), `setInterval(async () => fetch('/tasks/42/status'), 5000);\n`);
    writeFileSync(join(cwd, 'src', 'events.ts'), `const events = new QueueEvents('reports');\nevents.on('completed', handleCompleted);\n`);
    writeFileSync(join(cwd, 'src', 'upload.ts'), `app.post('/upload', (req, res) => { req.on('data', onChunk); return storage.putObject(req.body); });\n`);
    writeFileSync(join(cwd, 'src', 'retry.ts'), `setTimeout(() => retry(job), backoff(attempt));\n`);
    writeFileSync(join(cwd, 'src', 'review.ts'), `const statusPath = '/jobs/:id/status';\n`);
    writeFileSync(join(cwd, 'node_modules', 'ignored', 'queue.js'), `setInterval(() => fetch('/tasks/status'), 1000);\n`);
    const before = readFileSync(join(cwd, 'src', 'status.ts'), 'utf8');

    const result = spawnSync(process.execPath, [developerCLI, 'adopt', '--scan', '--json'], {
      cwd,
      encoding: 'utf8',
      env: {},
    });
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.mode, 'preview-only');
    assert.equal(report.filesScanned, 6);
    assert.deepEqual(report.detected, [
      'status routes',
      'polling hooks',
      'BullMQ lifecycle listeners',
      'upload proxies',
      'retry timers',
    ]);
    assert.equal(report.replaceableEstimate.files, 5);
    assert.equal(report.replaceableEstimate.matchingLines, 5);
    assert.equal(report.schemaVersion, 2);
    assert.equal(report.preview.changes.length, report.findings.length);
    assert.equal(report.preview.rollback.kind, 'patch-preview');
    assert.match(report.preview.diff, /manual-review/);
    assert.match(report.preview.rollback.patch, /manual-review/);
    assert.ok(report.findings.some((finding) => finding.file === 'src/review.ts' && finding.confidence === 'review'));
    assert.ok(report.findings.every((finding) => !finding.file.includes('node_modules')));
    assert.equal(readFileSync(join(cwd, 'src', 'status.ts'), 'utf8'), before);
    assert.equal(existsSync(join(cwd, '.rhinoq')), false);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('adopt --scan refuses mutation flags', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'rhinoq-eraser-flags-'));
  try {
    const result = spawnSync(process.execPath, [developerCLI, 'adopt', '--scan', '--apply'], {
      cwd,
      encoding: 'utf8',
      env: {},
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /preview-only/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('Integration Eraser excludes generated files, nested repositories and .rhinoqignore paths', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'rhinoq-eraser-ignore-'));
  try {
    mkdirSync(join(cwd, 'src', 'generated'), { recursive: true });
    mkdirSync(join(cwd, 'vendor-copy', '.git'), { recursive: true });
    writeFileSync(join(cwd, '.rhinoqignore'), 'src/ignored.ts\n');
    writeFileSync(join(cwd, 'src', 'live.ts'), `router.get('/tasks/:id/status', (_req, res) => res.json({ ok: true }));\n`);
    writeFileSync(join(cwd, 'src', 'ignored.ts'), `router.get('/tasks/:id/status', (_req, res) => res.json({ ignored: true }));\n`);
    writeFileSync(join(cwd, 'src', 'generated', 'status.ts'), `// @generated\nrouter.get('/tasks/:id/status', (_req, res) => res.json({ generated: true }));\n`);
    writeFileSync(join(cwd, 'vendor-copy', 'status.ts'), `router.get('/tasks/:id/status', (_req, res) => res.json({ vendor: true }));\n`);
    const report = JSON.parse(spawnSync(process.execPath, [developerCLI, 'adopt', '--scan', '--json'], { cwd, encoding: 'utf8', env: {} }).stdout);
    assert.equal(report.filesScanned, 1);
    assert.ok(report.skippedIgnoredFiles >= 3);
    assert.deepEqual(report.findings.map((finding) => finding.file), ['src/live.ts']);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});
