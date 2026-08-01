import { access, readFile } from 'node:fs/promises';

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
