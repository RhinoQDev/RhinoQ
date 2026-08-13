import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PACKAGE_ROOT } from './source-hash.mjs';

const sourcePath = join(PACKAGE_ROOT, 'contracts', 'owner-api.openapi.json');
const manifest = JSON.parse(await readFile(join(PACKAGE_ROOT, 'package.json'), 'utf8'));
const source = JSON.parse(await readFile(sourcePath, 'utf8'));
const implementation = await readFile(join(PACKAGE_ROOT, 'src', 'tasks', 'http.ts'), 'utf8');

if (source.openapi !== '3.1.0') throw new Error('owner API contract must use OpenAPI 3.1.0');
if (source.info?.version !== manifest.version) {
  throw new Error(`owner API contract is ${source.info?.version ?? 'missing'}, package is ${manifest.version}`);
}
const expectedOperations = [
  'listTasks', 'streamTasks', 'getTaskHealth', 'getTaskCapabilities',
  'listAtRiskTasks', 'listRecentlyVerifiedTasks', 'listWaitingTaskWaitpoints',
  'getTask', 'streamTask', 'getTaskSummary', 'getTaskExecutionResults',
  'listTaskExecutions', 'downloadFailedTaskItems', 'getTaskGroupManifest',
  'getTaskResult', 'cancelTask', 'retryTask', 'listTaskWaitpoints',
  'createTaskWaitpoint', 'getTaskWaitpoint', 'resolveTaskWaitpoint',
  'listTaskVerifications', 'listTaskArtifacts', 'downloadTaskArtifact',
  'refreshTaskArtifact',
  'createArtifactUpload', 'resumeArtifactUpload', 'signArtifactUploadPart',
  'recordArtifactUploadPart', 'completeArtifactUpload', 'abortArtifactUpload',
];
const operations = Object.values(source.paths ?? {}).flatMap((path) =>
  Object.values(path).map((operation) => operation.operationId),
);
if (new Set(operations).size !== operations.length) throw new Error('owner API operationId values must be unique');
const missingOperations = expectedOperations.filter((operation) => !operations.includes(operation));
const extraOperations = operations.filter((operation) => !expectedOperations.includes(operation));
if (missingOperations.length || extraOperations.length) {
  throw new Error(`owner API operation inventory drift: missing=${missingOperations.join(',') || 'none'} extra=${extraOperations.join(',') || 'none'}`);
}
const implementationMarkers = [
  "relative[0] === '_events'", "relative[0] === '_health'", "relative[0] === '_capabilities'",
  "relative[0] === '_risk'", "relative[0] === '_verified'", "relative[0] === '_waitpoints'",
  "relative[1] === 'events'", "relative[1] === 'summary'", "relative[1] === 'failed-items'",
  "relative[1] === 'manifest'", "relative[1] === 'executions'", "relative[1] === 'waitpoints'",
  "relative[1] === 'verifications'", "relative[1] === 'artifacts'", "relative[1] === 'result'",
  "relative[1] === 'cancel'", "relative[1] === 'retry'", "relative[3] === 'download'",
  "relative[3] === 'refresh'",
  "relative[0] === '_uploads'",
];
for (const marker of implementationMarkers) {
  if (!implementation.includes(marker)) throw new Error(`owner API implementation is missing ${marker}`);
}
for (const property of ['cancel', 'retry', 'result', 'waitpoints', 'stream', 'risk', 'tenant', 'verifications', 'artifacts', 'authorization']) {
  if (!source.components?.schemas?.TaskSurfaceCapabilities?.properties?.[property]) {
    throw new Error(`capability schema is missing ${property}`);
  }
}

if (process.argv.includes('--check')) {
  console.log(`PASS owner API OpenAPI ${manifest.version}`);
} else {
  await mkdir(join(PACKAGE_ROOT, 'dist'), { recursive: true });
  await writeFile(join(PACKAGE_ROOT, 'dist', 'openapi.json'), `${JSON.stringify(source, null, 2)}\n`);
  console.log(`owner-api: OpenAPI ${source.openapi} ${manifest.version}`);
}
