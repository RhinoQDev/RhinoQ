/** Minimal structural surface shared by Node, Express, Nest and Fastify replies. */
export interface RhinoQNodeResponse {
  statusCode?: number;
  setHeader?(name: string, value: string): unknown;
  end?(body?: string): unknown;
  code?(status: number): RhinoQNodeResponse;
  status?(status: number): RhinoQNodeResponse;
  header?(name: string, value: string): unknown;
  send?(body?: string): unknown;
}

/**
 * Sends a bounded RhinoQ Web Response through common Node framework replies.
 * The golden Task response is JSON only; streaming surfaces keep their
 * dedicated adapters and backpressure behavior.
 */
export async function sendRhinoQResponse(target: RhinoQNodeResponse, response: Response): Promise<void> {
  if (!target || !response) throw new TypeError('sendRhinoQResponse requires a target and Response');
  const body = await response.text();
  if (typeof target.code === 'function') target.code(response.status);
  else if (typeof target.status === 'function') target.status(response.status);
  else target.statusCode = response.status;
  response.headers.forEach((value, name) => {
    if (typeof target.header === 'function') target.header(name, value);
    else target.setHeader?.(name, value);
  });
  if (typeof target.send === 'function') target.send(body);
  else if (typeof target.end === 'function') target.end(body);
  else throw new TypeError('Node response target must expose send() or end()');
}
