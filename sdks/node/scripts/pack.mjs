// `npm pack` leaves any earlier tarball sitting next to the new one, and a
// tarball's name carries only its version — never its content. An artefact
// packed before a feature landed therefore keeps installing, under the version
// that implies the feature is present. This packs and removes the artefacts
// that could be mistaken for the result.
import { execFileSync } from 'node:child_process';
import { readdir, readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { PACKAGE_ROOT } from './source-hash.mjs';

const manifest = JSON.parse(await readFile(join(PACKAGE_ROOT, 'package.json'), 'utf8'));
const currentTarball = `rhinoq-node-${manifest.version}.tgz`;

const stale = (await readdir(PACKAGE_ROOT)).filter(
  (name) => /^rhinoq-node-.*\.tgz$/.test(name),
);
for (const name of stale) {
  await unlink(join(PACKAGE_ROOT, name));
  console.log(`removed stale artefact ${name}`);
}

// `npm pack` runs prepack, which rebuilds and re-stamps dist/build-info.json.
execFileSync('npm', ['pack'], {
  cwd: PACKAGE_ROOT,
  stdio: 'inherit',
  shell: process.platform === 'win32',
});

const info = JSON.parse(
  await readFile(join(PACKAGE_ROOT, 'dist', 'build-info.json'), 'utf8'),
);
console.log(
  `\npacked ${currentTarball}\n` +
    `  commit  ${info.commit?.slice(0, 8) ?? 'no-git'}${info.dirty ? ' (dirty tree)' : ''}\n` +
    `  src     ${info.sourceHash.slice(0, 12)}\n\n` +
    'Confirm what an application actually installed with:\n' +
    '  node scripts/verify-installed.mjs <path-to-application>',
);
