#!/usr/bin/env node
import { readFile, readdir } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import { spawn } from 'node:child_process';

const root = resolve('benchmarks/report-export');
const contract = JSON.parse(await readFile(resolve(root, 'acceptance.json'), 'utf8'));
if (!contract.baselineCommand || !contract.rhinoqCommand) {
  fail('acceptance commands are not configured; no LOC claim was produced');
}
await run(contract.baselineCommand, resolve(root, 'baseline'));
await run(contract.rhinoqCommand, resolve(root, 'rhinoq'));
const baseline = await count(resolve(root, 'baseline'));
const rhinoq = await count(resolve(root, 'rhinoq'));
if (!baseline.total || !rhinoq.total) fail('both implementations need countable source files');
console.log(JSON.stringify({ schemaVersion: 1, workload: contract.workload, baseline, rhinoq, methodology: 'nonblank noncomment consumer source; generated/test/lock files excluded' }, null, 2));

async function count(directory) {
  const totals = { frontend: 0, backend: 0, sql: 0, integration: 0, total: 0 };
  for (const path of await files(directory)) {
    if (/([\\/](test|tests|generated)[\\/]|\.test\.|\.spec\.|lock)/i.test(path)) continue;
    const ext = extname(path); if (!['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.sql', '.go'].includes(ext)) continue;
    const lines = (await readFile(path, 'utf8')).split(/\r?\n/).filter((line) => line.trim() && !/^\s*(\/\/|\/\*|\*|--)/.test(line)).length;
    const category = ext === '.sql' ? 'sql' : ['.tsx', '.jsx'].includes(ext) || /[\\/]web[\\/]/i.test(path) ? 'frontend' : /rhinoq|integration/i.test(path) ? 'integration' : 'backend';
    totals[category] += lines; totals.total += lines;
  }
  return totals;
}
async function files(directory) { const out = []; for (const item of await readdir(directory, { withFileTypes: true })) { const path = resolve(directory, item.name); if (item.isDirectory()) out.push(...await files(path)); else out.push(path); } return out; }
function run(command, cwd) { return new Promise((resolveRun, reject) => { const child = spawn(command, { cwd, shell: true, stdio: 'inherit' }); child.on('error', reject); child.on('close', (code) => code === 0 ? resolveRun() : reject(new Error(`acceptance command failed with ${code}`))); }); }
function fail(message) { console.error(`FAIL ${message}`); process.exit(1); }
