import { access, readFile } from 'node:fs/promises';
import { computeSourceHash } from './source-hash.mjs';

const tag = process.argv[2] || process.env.GITHUB_REF_NAME;
if (!tag) {
  throw new Error('Pass a release tag, for example: npm run release:check -- v0.1.0-beta.4');
}

const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url)));
const expectedVersion = tag.replace(/^v/, '');
const gatewayTypes = await readFile(
  new URL('../src/gateway/types.ts', import.meta.url),
  'utf8',
);
const sdkVersion = gatewayTypes.match(
  /export const SDK_VERSION = '([^']+)'/,
)?.[1];

if (manifest.version !== expectedVersion) {
  throw new Error(`package.json is ${manifest.version}, but the release tag is ${tag}`);
}
if (sdkVersion !== manifest.version) {
  throw new Error(
    `SDK_VERSION is ${sdkVersion ?? 'missing'}, but package.json is ${manifest.version}`,
  );
}
if (manifest.version.endsWith('-dev')) {
  throw new Error('A -dev package cannot be published. Use an explicit prerelease or stable semver version.');
}

const expectedBins = {
  rhinoq: 'dist/cli/rhinoq.js',
  'rhinoq-task': 'dist/cli/task-migrate.js',
  'rhinoq-task-check': 'dist/cli/task-check.js',
};
for (const [name, relativePath] of Object.entries(expectedBins)) {
  if (manifest.bin?.[name] !== relativePath) {
    throw new Error(
      `bin[${name}] must be ${relativePath}; npm 12 rejects non-canonical paths`,
    );
  }
  await access(new URL(`../${relativePath}`, import.meta.url));
}

// The three checks above all read package.json, so they pass just as happily
// against a dist/ built weeks earlier. Provenance is what distinguishes a
// release from an artefact that merely carries the release's version.
const buildInfo = JSON.parse(
  await readFile(new URL('../dist/build-info.json', import.meta.url), 'utf8'),
);

if (buildInfo.sourceHash !== (await computeSourceHash())) {
  throw new Error(
    'dist/ was built from different source than this checkout. Run npm run build before releasing.',
  );
}
if (buildInfo.version !== manifest.version) {
  throw new Error(
    `dist/ was built at ${buildInfo.version}, but package.json is ${manifest.version}`,
  );
}
if (buildInfo.dirty) {
  throw new Error(
    'dist/ was built from a dirty working tree; a published artefact must be reproducible from a commit.',
  );
}
