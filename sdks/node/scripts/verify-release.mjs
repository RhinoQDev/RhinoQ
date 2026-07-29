import { readFile } from 'node:fs/promises';

const tag = process.argv[2] || process.env.GITHUB_REF_NAME;
if (!tag) {
  throw new Error('Pass a release tag, for example: npm run release:check -- v0.1.0-beta.1');
}

const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url)));
const expectedVersion = tag.replace(/^v/, '');

if (manifest.version !== expectedVersion) {
  throw new Error(`package.json is ${manifest.version}, but the release tag is ${tag}`);
}
if (manifest.version.endsWith('-dev')) {
  throw new Error('A -dev package cannot be published. Use an explicit prerelease or stable semver version.');
}
