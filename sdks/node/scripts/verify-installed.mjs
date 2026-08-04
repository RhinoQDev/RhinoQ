// Answers the one question a `file:` install cannot answer for itself: is the
// copy in an application's node_modules actually built from this checkout?
//
//   node scripts/verify-installed.mjs ../../../some-app
//
// Exits non-zero on a mismatch, so it can gate an integration run. Without it a
// stale tarball keeps the version it was packed under and installs silently.
import { readFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { PACKAGE_ROOT, computeSourceHash } from './source-hash.mjs';

const target = process.argv[2];
if (!target) {
  console.error(
    'Pass the application directory or the installed package directory, ' +
      'for example: node scripts/verify-installed.mjs ../../../my-app',
  );
  process.exit(2);
}

const base = isAbsolute(target) ? target : resolve(process.cwd(), target);

async function readBuildInfo() {
  const candidates = [
    join(base, 'node_modules', '@rhinoq', 'node', 'dist', 'build-info.json'),
    join(base, 'dist', 'build-info.json'),
  ];
  for (const candidate of candidates) {
    try {
      return { path: candidate, info: JSON.parse(await readFile(candidate, 'utf8')) };
    } catch (error) {
      if (error.code !== 'ENOENT') {
        throw error;
      }
    }
  }
  return { path: candidates[0], info: null };
}

const expectedHash = await computeSourceHash();
const manifest = JSON.parse(await readFile(join(PACKAGE_ROOT, 'package.json'), 'utf8'));
const { path, info } = await readBuildInfo();

if (info === null) {
  console.error(
    `No build-info.json under ${base}.\n` +
      'Either nothing is installed there, or it predates build provenance — ' +
      'which means it cannot be trusted to match this source. Re-pack and re-install.',
  );
  process.exit(1);
}

if (info.sourceHash !== expectedHash) {
  console.error(
    `Installed @rhinoq/node does not match this checkout.\n` +
      `  installed  ${info.version} ${info.commit?.slice(0, 8) ?? 'no-git'} ` +
      `src:${info.sourceHash?.slice(0, 12)} built ${info.builtAt}\n` +
      `  checkout   ${manifest.version} src:${expectedHash.slice(0, 12)}\n` +
      `  read from  ${path}\n` +
      'The version number matching proves nothing; re-run `npm run pack` and re-install.',
  );
  process.exit(1);
}

if (info.dirty) {
  console.warn('Installed build came from a dirty working tree; it matches src but is not reproducible.');
}

console.log(
  `Installed @rhinoq/node matches this checkout: ${info.version} ` +
    `${info.commit?.slice(0, 8) ?? 'no-git'} src:${expectedHash.slice(0, 12)}`,
);
