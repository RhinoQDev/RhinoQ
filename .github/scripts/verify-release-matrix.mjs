import { readFile } from 'node:fs/promises';

const tag = process.argv[2] || process.env.GITHUB_REF_NAME;
if (!tag?.startsWith('v')) throw new Error('release tag must be v<semver>');
const version = tag.slice(1);
const readJSON = async (path) => JSON.parse(await readFile(new URL(`../../${path}`, import.meta.url), 'utf8'));

const node = await readJSON('sdks/node/package.json');
const lock = await readJSON('sdks/node/package-lock.json');
const alias = await readJSON('sdks/rhinoq/package.json');
const changelog = await readFile(new URL('../../CHANGELOG.md', import.meta.url), 'utf8');

const versions = {
  '@rhinoq/node': node.version,
  'node lock': lock.version,
  'node lock root': lock.packages?.['']?.version,
  rhinoq: alias.version,
  'rhinoq dependency': alias.dependencies?.['@rhinoq/node'],
};
for (const [name, actual] of Object.entries(versions)) {
  if (actual !== version) throw new Error(`${name} is ${actual ?? 'missing'}, expected ${version}`);
}
if (!changelog.includes(`## ${version}`)) throw new Error(`CHANGELOG.md has no ## ${version} release section`);

const expectedTag = version.includes('-') ? 'next' : 'latest';
for (const manifest of [node, alias]) {
  if (manifest.publishConfig?.tag !== expectedTag) {
    throw new Error(`${manifest.name} publishConfig.tag must be ${expectedTag}`);
  }
}

console.log(`PASS release matrix ${version} (${expectedTag})`);
