export interface WaitpointTokenClaims {
  schemaVersion: 1; waitpointId: string; taskId: string; ownerId: string;
  action: 'read' | 'resolve'; expiresAt: number; nonce: string;
}

/** Application-owned HMAC capability token; RhinoQ never stores the secret. */
export function createWaitpointTokenSigner(secret: string | Uint8Array) {
  const keyBytes = typeof secret === 'string' ? new TextEncoder().encode(secret) : new Uint8Array(secret);
  if (keyBytes.byteLength < 32) throw new RangeError('waitpoint token secret must be at least 32 bytes');
  let key: Promise<CryptoKey> | undefined;
  const cryptoKey = () => key ??= globalThis.crypto.subtle.importKey('raw', keyBytes.slice().buffer as ArrayBuffer, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign','verify']);
  return {
    async sign(input: Omit<WaitpointTokenClaims, 'schemaVersion'>): Promise<string> {
      validateClaims({ ...input, schemaVersion: 1 });
      const payload = base64url(new TextEncoder().encode(JSON.stringify({ ...input, schemaVersion: 1 })));
      const signature = await globalThis.crypto.subtle.sign('HMAC', await cryptoKey(), new TextEncoder().encode(payload));
      return `${payload}.${base64url(new Uint8Array(signature))}`;
    },
    async verify(token: string, expectedAction?: WaitpointTokenClaims['action'], now = Date.now()): Promise<WaitpointTokenClaims> {
      const [payload, signature, extra] = token?.split('.') ?? [];
      if (!payload || !signature || extra) throw new Error('invalid waitpoint token');
      const valid = await globalThis.crypto.subtle.verify('HMAC', await cryptoKey(), fromBase64url(signature).slice().buffer as ArrayBuffer, new TextEncoder().encode(payload));
      if (!valid) throw new Error('invalid waitpoint token signature');
      const claims = JSON.parse(new TextDecoder().decode(fromBase64url(payload))) as WaitpointTokenClaims;
      validateClaims(claims);
      if (claims.expiresAt <= now) throw new Error('waitpoint token expired');
      if (expectedAction && claims.action !== expectedAction) throw new Error('waitpoint token action mismatch');
      return claims;
    },
  };
}

function validateClaims(value: WaitpointTokenClaims): void {
  if (value.schemaVersion !== 1 || !value.waitpointId?.trim() || !value.taskId?.trim() || !value.ownerId?.trim() ||
      !value.nonce?.trim() || !['read','resolve'].includes(value.action) || !Number.isSafeInteger(value.expiresAt) || value.expiresAt <= 0) {
    throw new TypeError('valid waitpoint token claims are required');
  }
}
function base64url(value: Uint8Array): string { return Buffer.from(value).toString('base64url'); }
function fromBase64url(value: string): Uint8Array { return new Uint8Array(Buffer.from(value, 'base64url')); }
