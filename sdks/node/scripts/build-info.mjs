// Stamps provenance into the build so an installed copy can be checked against
// the checkout it claims to come from. Runs at the end of `npm run build`, so
// every artefact that reaches a tarball carries one.
import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PACKAGE_ROOT, computeSourceHash } from './source-hash.mjs';

function git(...args) {
  try {
    return execFileSync('git', args, {
      cwd: PACKAGE_ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    // A tarball unpacked outside a repository still builds; provenance simply
    // falls back to the source hash, which is the load-bearing field anyway.
    return null;
  }
}

const manifest = JSON.parse(await readFile(join(PACKAGE_ROOT, 'package.json'), 'utf8'));
const commit = git('rev-parse', 'HEAD');
const buildInfo = {
  version: manifest.version,
  sourceHash: await computeSourceHash(),
  commit,
  dirty: commit === null ? null : git('status', '--porcelain', '--', '.') !== '',
  builtAt: new Date().toISOString(),
};

const serialised = `${JSON.stringify(buildInfo, null, 2)}\n`;
await writeFile(join(PACKAGE_ROOT, 'dist', 'build-info.json'), serialised);
await writeFile(join(PACKAGE_ROOT, 'dist', 'cjs', 'build-info.json'), serialised);

console.log(
  `build-info: ${buildInfo.version} ${commit ? commit.slice(0, 8) : 'no-git'}` +
    `${buildInfo.dirty ? '-dirty' : ''} src:${buildInfo.sourceHash.slice(0, 12)}`,
);
