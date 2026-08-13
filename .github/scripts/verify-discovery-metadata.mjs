import { readFile, stat } from 'node:fs/promises';

const root = new URL('../../', import.meta.url);
const read = (path) => readFile(new URL(path, root), 'utf8');
const json = async (path) => JSON.parse(await read(path));
const [metadata, nodePackage, aliasPackage, readme] = await Promise.all([
  json('.github/repository-metadata.json'),
  json('sdks/node/package.json'),
  json('sdks/rhinoq/package.json'),
  read('README.md'),
]);

const requiredTopics = [
  'async-tasks', 'background-jobs', 'bullmq', 'job-queue', 'nestjs', 'nodejs',
  'postgresql-queue', 'sse', 'task-queue',
];
for (const topic of requiredTopics) {
  if (!metadata.topics.includes(topic)) throw new Error(`repository topic ${topic} is missing`);
  if (!nodePackage.keywords?.includes(topic)) throw new Error(`@rhinoq/node keyword ${topic} is missing`);
  if (!aliasPackage.keywords?.includes(topic)) throw new Error(`rhinoq keyword ${topic} is missing`);
}
if (nodePackage.description !== aliasPackage.description) {
  throw new Error('npm package descriptions must stay aligned');
}

const readmeEntry = readme.slice(0, 4_000).toLowerCase();
for (const phrase of ['background job', 'postgresql queue', 'bullmq', 'task api', 'sse', 'nestjs']) {
  if (!readmeEntry.includes(phrase)) throw new Error(`README entry is missing ${JSON.stringify(phrase)}`);
}

const preview = new URL('docs/assets/rhinoq-social-preview.jpg', root);
const previewStat = await stat(preview);
if (previewStat.size >= 1_000_000) throw new Error('social preview must remain below 1 MB');
const dimensions = jpegDimensions(await readFile(preview));
if (dimensions.width !== 1280 || dimensions.height !== 640) {
  throw new Error(`social preview is ${dimensions.width}x${dimensions.height}, expected 1280x640`);
}

console.log(`PASS discovery metadata: ${metadata.topics.length} topics, ${dimensions.width}x${dimensions.height} social preview`);

function jpegDimensions(buffer) {
  if (buffer[0] !== 0xff || buffer[1] !== 0xd8) throw new Error('social preview is not a JPEG');
  let offset = 2;
  while (offset + 8 < buffer.length) {
    if (buffer[offset] !== 0xff) { offset += 1; continue; }
    const marker = buffer[offset + 1];
    const length = buffer.readUInt16BE(offset + 2);
    if (marker >= 0xc0 && marker <= 0xc3) {
      return { height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7) };
    }
    offset += 2 + length;
  }
  throw new Error('social preview JPEG dimensions could not be read');
}
