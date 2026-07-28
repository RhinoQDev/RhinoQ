import {
  RhinoQClient,
  RhinoQWorker,
} from '@rhinoq/node';

const client = new RhinoQClient({
  url: process.env.RHINOQ_GATEWAY_URL,
  token: process.env.RHINOQ_GATEWAY_TOKEN,
});
const worker = new RhinoQWorker({
  client,
  name: `reports-${process.pid}`,
  concurrency: 4,
  onError: console.error,
});

worker.handle('generate-report', async (job) => {
  console.log(`generate report ${job.data.reportId}`);
  // Pass job.signal to HTTP/database calls that support AbortSignal.
});

const stopping = new AbortController();
process.once('SIGTERM', () => stopping.abort());
process.once('SIGINT', () => stopping.abort());
await worker.run({ signal: stopping.signal });
