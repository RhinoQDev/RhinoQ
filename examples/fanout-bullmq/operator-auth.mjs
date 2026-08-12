import { createHash, timingSafeEqual } from 'node:crypto';
import express from 'express';

const COOKIE = 'rhinoq_operator_session';

export function createOperatorLoginRouter({ token, secure = false }) {
  if (!token?.trim()) throw new TypeError('operator login requires a non-empty token');
  const router = express.Router();
  router.use(express.urlencoded({ extended: false, limit: '8kb' }));
  router.get('/operator-login', (_request, response) => {
    response.set({
      'cache-control': 'no-store',
      'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    });
    response.type('html').send('<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>RhinoQ operator sign in</title><style>body{font:16px system-ui;max-width:32rem;margin:10vh auto;padding:1rem}label,input,button{display:block;width:100%;box-sizing:border-box}input,button{font:inherit;padding:.7rem;margin-top:.5rem}p{color:#555}</style><h1>Operator sign in</h1><p>Enter the token configured on this local example. It is exchanged for an HttpOnly cookie and is not placed in the URL.</p><form method="post" action="/operator-login"><label>Operator token<input name="token" type="password" required autocomplete="current-password"></label><button type="submit">Open Workbench</button></form></html>');
  });
  router.post('/operator-login', (request, response) => {
    if (!safeEqual(String(request.body?.token ?? ''), token)) {
      response.status(403).type('text').send('Invalid operator token');
      return;
    }
    response.cookie(COOKIE, operatorSession(token), {
      httpOnly: true, sameSite: 'strict', path: '/admin/rhinoq', secure,
    });
    response.redirect(303, '/admin/rhinoq');
  });
  return router;
}

export function operatorAuthorized(headers, token) {
  const header = headers.get('x-operator-token');
  if (header && safeEqual(header, token)) return true;
  const expected = operatorSession(token);
  const cookie = headers.get('cookie')?.split(';')
    .map((part) => part.trim().split('='))
    .find(([name]) => name === COOKIE)?.[1];
  return Boolean(cookie && safeEqual(cookie, expected));
}

export function operatorSession(token) {
  return createHash('sha256').update(`rhinoq-operator-session\0${token}`).digest('base64url');
}

function safeEqual(left, right) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
