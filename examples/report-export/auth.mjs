const sessions = new Map([
  ['alice-demo-session', { ownerId: 'owner-alice', tenantId: 'tenant-demo' }],
  ['bob-demo-session', { ownerId: 'owner-bob', tenantId: 'tenant-demo' }],
]);

export function demoSession(request) {
  const cookies = String(request.headers.cookie ?? '').split(';');
  const entry = cookies.map((cookie) => cookie.trim().split('=', 2))
    .find(([name]) => name === 'rhinoq_demo_session');
  return entry ? sessions.get(entry[1]) : undefined;
}

export function loginSession(name) {
  const token = `${name}-demo-session`;
  if (!sessions.has(token)) throw new TypeError('unknown demo user');
  return token;
}

export function authorizeDemoTenant({ request, ownerId, tenantId }) {
  const session = demoSession(request);
  return session?.ownerId === ownerId && session.tenantId === tenantId;
}
