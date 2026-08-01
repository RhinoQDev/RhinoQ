export {};

const base = process.env.APP_URL ?? 'http://127.0.0.1:53000';
const post = async (action: string, orderId?: string) => {
  const response = await fetch(`${base}/api/demo`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action, orderId }) });
  const body = await response.json();
  if (!response.ok) throw new Error(`${action}: ${JSON.stringify(body)}`);
  return body as Record<string, unknown>;
};
const created = await post('create');
const orderId = String(created.orderId);
let state: any;
for (let attempt=0; attempt<80; attempt++) {
  await new Promise((resolve) => setTimeout(resolve, 250));
  state = await fetch(`${base}/api/state`).then((response) => response.json());
  if (state.job === 'completed' && state.task?.state === 'uncertain' && state.finding?.status === 'open') break;
}
if (state.job !== 'completed' || state.task?.state !== 'uncertain' || state.provider?.state !== 'uncertain') throw new Error(`failure was not reproduced: ${JSON.stringify(state)}`);
if (!state.providerEvidence?.some((item: { kind: string; payload: string }) => item.kind === 'resolution' && /timeout/i.test(item.payload))) throw new Error('uncertain timeout evidence missing');
await post('recheck', orderId);
await post('propose', orderId);
await post('preview', orderId);
await post('approve', orderId);
await post('execute', orderId);
state = await fetch(`${base}/api/state`).then((response) => response.json());
if (state.provider?.state !== 'confirmed' || state.task?.state !== 'succeeded' || state.finding?.status !== 'resolved' || state.order?.state !== 'refunded' || state.repair?.state !== 'succeeded') throw new Error(`safe recovery failed: ${JSON.stringify(state)}`);
console.log(`PASS ${orderId}: BullMQ completed -> uncertain -> confirmed -> approved repair -> verified`);
