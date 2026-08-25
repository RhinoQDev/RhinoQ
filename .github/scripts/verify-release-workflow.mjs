import { readFile } from 'node:fs/promises';

const workflow = await readFile(new URL('../workflows/release.yml', import.meta.url), 'utf8');

const jobs = new Map();
const jobPattern = /^  ([a-z][a-z0-9-]*):\r?$/gim;
const matches = [...workflow.matchAll(jobPattern)];
for (let index = 0; index < matches.length; index += 1) {
  const match = matches[index];
  const start = match.index;
  const end = matches[index + 1]?.index ?? workflow.length;
  jobs.set(match[1], workflow.slice(start, end));
}

const requireJob = (name) => {
  const job = jobs.get(name);
  if (!job) throw new Error(`release workflow is missing job ${name}`);
  return job;
};

const nodePublish = requireJob('node-publish');
const aliasPublish = requireJob('node-publish-alias');
const containerPublish = requireJob('container');

for (const [name, job] of [
  ['node-publish', nodePublish],
  ['node-publish-alias', aliasPublish],
]) {
  if (!job.includes('id-token: write')) {
    throw new Error(`${name} must have GitHub OIDC permission`);
  }
  if (/NODE_AUTH_TOKEN|NPM_BOOTSTRAP_TOKEN/.test(job)) {
    throw new Error(`${name} must use OIDC and must not read a bootstrap token`);
  }
  if (!job.includes('npm publish --access public --tag "$tag"')) {
    throw new Error(`${name} must publish through the OIDC path`);
  }
}

const expectedContainer = 'ghcr.io/rhinoqdev/rhinoq';
if (!containerPublish.includes(`tags: ${expectedContainer}:`)) {
  throw new Error(`container must publish to ${expectedContainer}`);
}
if (!containerPublish.includes(`subject-name: ${expectedContainer}`)) {
  throw new Error(`container attestation subject must be ${expectedContainer}`);
}

console.log('PASS release workflow npm authentication contract');
