import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import express from 'express';
import { createOperatorLoginRouter, operatorAuthorized } from './operator-auth.mjs';

test('browser login exchanges the token for an opaque scoped cookie', async () => {
  const token = 'operator-secret-not-for-html';
  const app = express();
  app.use(createOperatorLoginRouter({ token }));
  app.get('/admin/rhinoq/probe', (request, response) => {
    const headers = new Headers();
    for (const [name, value] of Object.entries(request.headers)) {
      if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(', ') : value);
    }
    response.sendStatus(operatorAuthorized(headers, token) ? 204 : 403);
  });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const form = await fetch(`${base}/operator-login`);
    assert.equal(form.status, 200);
    assert.equal((await form.text()).includes(token), false);

    const refused = await fetch(`${base}/operator-login`, {
      method: 'POST', redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'token=wrong',
    });
    assert.equal(refused.status, 403);
    assert.equal(refused.headers.get('set-cookie'), null);

    const login = await fetch(`${base}/operator-login`, {
      method: 'POST', redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: `token=${encodeURIComponent(token)}`,
    });
    assert.equal(login.status, 303);
    assert.equal(login.headers.get('location'), '/admin/rhinoq');
    const setCookie = login.headers.get('set-cookie');
    assert.match(setCookie, /^rhinoq_operator_session=[^;]+; Path=\/admin\/rhinoq; HttpOnly; SameSite=Strict$/);
    assert.equal(setCookie.includes(token), false);

    const cookie = setCookie.split(';', 1)[0];
    assert.equal((await fetch(`${base}/admin/rhinoq/probe`, { headers: { cookie } })).status, 204);
    assert.equal((await fetch(`${base}/admin/rhinoq/probe`)).status, 403);
    assert.equal((await fetch(`${base}/admin/rhinoq/probe`, { headers: { 'x-operator-token': token } })).status, 204);
  } finally {
    server.close();
    await once(server, 'close');
  }
});
