import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { test } from 'node:test';

import { createClient } from '../src/client.mjs';

const { privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});
const SA = { clientEmail: 'sa@proj.iam.gserviceaccount.com', privateKey };
const json = (obj, init = {}) => new Response(JSON.stringify(obj), { status: 200, ...init });

function fakeFetch(handler) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init });
    if (String(url).includes('oauth2.googleapis.com/token')) return json({ access_token: 'tok', expires_in: 3600 });
    return handler(String(url), init, calls.length);
  };
  return { fetchImpl, calls };
}

test('public API không lộ private key', () => {
  const { fetchImpl } = fakeFetch(() => json({}));
  const client = createClient({ credentials: SA, fetchImpl });
  assert.equal(client.credentials, undefined);
  assert.equal(client.tokenSource.credentials, undefined);
  assert.deepEqual(client.identity, { type: 'service_account', clientEmail: SA.clientEmail, source: 'explicit' });
  assert.ok(!JSON.stringify(client).includes('PRIVATE KEY'));
});

test('401 → lấy token mới và gửi lại ĐÚNG MỘT lần', async () => {
  let apiCalls = 0;
  const { fetchImpl, calls } = fakeFetch(() => (++apiCalls === 1 ? json({}, { status: 401 }) : json({ ok: true })));
  const client = createClient({ credentials: SA, fetchImpl });
  const out = await client.api({ url: 'https://www.googleapis.com/drive/v3/about' });
  assert.deepEqual(out, { ok: true });
  assert.equal(calls.filter((c) => c.url.includes('/token')).length, 2, 'token bị xin lại sau 401');
  assert.equal(apiCalls, 2);
});

test('api() chuyển tiếp idempotent=false: timeout không gửi lại', async () => {
  let apiCalls = 0;
  const { fetchImpl } = fakeFetch((url, init) => new Promise((_, reject) => { apiCalls++; init.signal.addEventListener('abort', () => reject(init.signal.reason)); }));
  const client = createClient({ credentials: SA, fetchImpl, retries: 3, timeoutMs: 20 });
  await assert.rejects(
    client.api({ url: 'https://sheets.googleapis.com/v4/x:append', method: 'POST', idempotent: false }),
    (e) => e.code === 'UNCERTAIN_WRITE',
  );
  assert.equal(apiCalls, 1);
});

test('không quá `concurrency` request API chạy cùng lúc', async () => {
  let active = 0, peak = 0;
  const { fetchImpl } = fakeFetch(async () => {
    active++; peak = Math.max(peak, active);
    await new Promise((r) => setTimeout(r, 5));
    active--;
    return json({});
  });
  const client = createClient({ credentials: SA, fetchImpl, concurrency: 2 });
  await Promise.all(Array.from({ length: 6 }, () => client.api({ url: 'https://www.googleapis.com/drive/v3/files/x' })));
  assert.equal(peak, 2);
});
