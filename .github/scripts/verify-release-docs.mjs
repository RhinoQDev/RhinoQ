import { readFile } from 'node:fs/promises';

const root = new URL('../../', import.meta.url);
const read = (path) => readFile(new URL(path, root), 'utf8');
const readJSON = async (path) => JSON.parse(await read(path));

const manifest = await readJSON('sdks/node/package.json');
const alias = await readJSON('sdks/rhinoq/package.json');
const lock = await readJSON('sdks/node/package-lock.json');
const gatewayTypes = await read('sdks/node/src/gateway/types.ts');
const rootReadme = await read('README.md');
const packageReadme = await read('sdks/node/README.md');
const aliasReadme = await read('sdks/rhinoq/README.md');

const requested = process.argv[2]
  || (process.env.GITHUB_REF_TYPE === 'tag' ? process.env.GITHUB_REF_NAME : undefined);
const expected = requested ? requested.replace(/^v/, '') : manifest.version;
const sdkVersion = gatewayTypes.match(/export const SDK_VERSION = '([^']+)'/)?.[1];

const versions = {
  '@rhinoq/node': manifest.version,
  rhinoq: alias.version,
  'rhinoq dependency': alias.dependencies?.['@rhinoq/node'],
  'node lock': lock.version,
  'node lock root': lock.packages?.['']?.version,
  SDK_VERSION: sdkVersion,
};
for (const [source, actual] of Object.entries(versions)) {
  if (actual !== expected) {
    throw new Error(`${source} is ${actual ?? 'missing'}, expected ${expected}`);
  }
}

const tag = `v${expected}`;
const documentation = {
  'README.md': [rootReadme, `Latest verified public prerelease: \`${tag}\`.`],
  'sdks/node/README.md': [packageReadme, `Latest verified npm prerelease: \`${tag}\`.`],
  'sdks/rhinoq/README.md': [aliasReadme, `Latest verified npm prerelease: \`${tag}\`.`],
};
for (const [path, [contents, marker]] of Object.entries(documentation)) {
  if (!contents.includes(marker)) {
    throw new Error(`${path} must contain ${JSON.stringify(marker)}`);
  }
  const staleClaim = new RegExp(
    `(?:unreleased|main-only)[^\\n]{0,100}${expected.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&')}`,
    'i',
  );
  if (staleClaim.test(contents)) {
    throw new Error(`${path} still describes ${expected} as unreleased/main-only`);
  }
}

console.log(`PASS release documentation ${expected}`);
