import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  buildQuery,
  createLimiter,
  GoogleApiError,
  isRetryable,
  isTransient,
  request,
  retryDelayMs,
  TimeoutError,
  UncertainWriteError,
} from '../src/http.mjs';

function res({ ok = true, status = 200, body = '{}', headers = {} } = {}) {
  return {
    ok,
    status,
    url: 'https://example.test/x',
    headers: { get: (k) => headers[k.toLowerCase()] ?? null },
    text: async () => body,
    arrayBuffer: async () => new TextEncoder().encode(body).buffer,
  };
}

test('buildQuery bỏ undefined/null, giữ false và 0', () => {
  assert.equal(buildQuery({ a: 1, b: undefined, c: null, d: false, e: 0 }), '?a=1&d=false&e=0');
  assert.equal(buildQuery({}), '');
  assert.equal(buildQuery({ r: ['x', 'y'] }), '?r=x&r=y');
});

test('buildQuery encode ký tự đặc biệt của range A1', () => {
  assert.match(buildQuery({ range: "'Tab A'!B2:C3" }), /%27Tab\+A%27%21B2%3AC3/);
});

// HỢP ĐỒNG: packflow đọc Number(err.code ?? err.response.status). Đây là test canh giữ nó.
test('lỗi REST mang code SỐ và response.status', async () => {
  const err = new GoogleApiError(429, {
    error: { code: 429, message: 'Quota exceeded', errors: [{ reason: 'rateLimitExceeded' }] },
  });
  assert.equal(typeof err.code, 'number');
  assert.equal(err.code, 429);
  assert.equal(err.status, 429);
  assert.equal(err.response.status, 429);
  assert.equal(err.message, 'Quota exceeded');
  assert.equal(err.reason, 'rateLimitExceeded');
});

test('lỗi OAuth (error là CHUỖI) lấy được error_description', () => {
  const err = new GoogleApiError(400, {
    error: 'invalid_grant',
    error_description: 'Invalid JWT Signature.',
  });
  assert.equal(err.message, 'Invalid JWT Signature.');
  assert.equal(err.reason, 'invalid_grant');
  assert.equal(err.code, 400);
});

test('body không phải JSON (HTML từ load balancer) vẫn ra lỗi dùng được', async () => {
  const fetchImpl = async () => res({ ok: false, status: 502, body: '<html>Bad Gateway</html>' });
  await assert.rejects(request({ url: 'https://x.test', fetchImpl }), (err) => {
    assert.equal(err.code, 502);
    assert.equal(err.response.data, '<html>Bad Gateway</html>');
    return true;
  });
});

test('isTransient: theo status và theo message mạng', () => {
  for (const s of [408, 429, 500, 502, 503, 504]) {
    assert.ok(isTransient({ code: s }), `status ${s}`);
  }
  for (const s of [400, 401, 403, 404]) {
    assert.equal(isTransient({ code: s }), false, `status ${s}`);
  }
  assert.ok(isTransient(new TypeError('fetch failed')));
  assert.ok(isTransient({ message: 'socket hang up' }));
  assert.equal(isTransient(new Error('bí ẩn')), false);
});

test('retries=0 mặc định: không thử lại', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    return res({ ok: false, status: 503, body: '{}' });
  };
  await assert.rejects(request({ url: 'https://x.test', fetchImpl }));
  assert.equal(calls, 1);
});

test('retries>0 chỉ thử lại lỗi tạm thời', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    return calls < 3 ? res({ ok: false, status: 503 }) : res({ body: '{"ok":true}' });
  };
  const out = await request({ url: 'https://x.test', fetchImpl, retries: 3, sleepImpl: async () => {} });
  assert.deepEqual(out, { ok: true });
  assert.equal(calls, 3);
});

test('retries>0 KHÔNG thử lại lỗi vĩnh viễn (403)', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    return res({ ok: false, status: 403, body: '{"error":{"message":"no access","errors":[{"reason":"forbidden"}]}}' });
  };
  await assert.rejects(request({ url: 'https://x.test', fetchImpl, retries: 3, sleepImpl: async () => {} }));
  assert.equal(calls, 1);
});

test('body object → JSON + content-type; token → header authorization', async () => {
  let seen;
  const fetchImpl = async (url, init) => {
    seen = init;
    return res({ body: '{}' });
  };
  await request({ url: 'https://x.test', method: 'POST', body: { a: 1 }, token: 'tk', fetchImpl });
  assert.equal(seen.body, '{"a":1}');
  assert.equal(seen.headers['content-type'], 'application/json; charset=UTF-8');
  assert.equal(seen.headers.authorization, 'Bearer tk');
});

test('body nhị phân không bị JSON hoá', async () => {
  let seen;
  const fetchImpl = async (url, init) => {
    seen = init;
    return res({ body: '{}' });
  };
  const bytes = new Uint8Array([1, 2, 3]);
  await request({ url: 'https://x.test', method: 'PUT', body: bytes, fetchImpl });
  assert.equal(seen.body, bytes);
  assert.equal(seen.headers['content-type'], undefined);
});

test('responseType raw trả nguyên Response để đọc header', async () => {
  const fetchImpl = async () => res({ headers: { location: 'https://upload.test/session' } });
  const out = await request({ url: 'https://x.test', responseType: 'raw', fetchImpl });
  assert.equal(out.headers.get('Location'), 'https://upload.test/session');
});

test('response rỗng (204) trả object rỗng chứ không nổ JSON.parse', async () => {
  const fetchImpl = async () => res({ status: 204, body: '' });
  assert.deepEqual(await request({ url: 'https://x.test', fetchImpl }), {});
});

const rateLimited = () =>
  res({ ok: false, status: 403, body: '{"error":{"message":"Rate Limit Exceeded","errors":[{"reason":"userRateLimitExceeded"}]}}' });

test('403 giới hạn tốc độ của Drive ĐƯỢC thử lại; 403 thiếu quyền thì KHÔNG', async () => {
  let calls = 0;
  const fetchImpl = async () => (++calls < 3 ? rateLimited() : res({ body: '{"ok":true}' }));
  await request({ url: 'https://x.test', fetchImpl, retries: 3, sleepImpl: async () => {} });
  assert.equal(calls, 3);

  calls = 0;
  const denied = async () => { calls++; return res({ ok: false, status: 403, body: '{"error":{"message":"no access","errors":[{"reason":"forbidden"}]}}' }); };
  await assert.rejects(request({ url: 'https://x.test', fetchImpl: denied, retries: 3, sleepImpl: async () => {} }));
  assert.equal(calls, 1);
});

test('Retry-After được tôn trọng, backoff có jitter trong [exp/2, exp] và không vượt trần', async () => {
  const delays = [];
  let calls = 0;
  const fetchImpl = async () =>
    ++calls === 1
      ? res({ ok: false, status: 429, body: '{}', headers: { 'retry-after': '2' } })
      : res({ body: '{}' });
  await request({ url: 'https://x.test', fetchImpl, retries: 2, sleepImpl: async (ms) => { delays.push(ms); } });
  assert.deepEqual(delays, [2000]);

  assert.equal(retryDelayMs(0, null, { baseDelayMs: 500, random: () => 0 }), 250);
  assert.equal(retryDelayMs(0, null, { baseDelayMs: 500, random: () => 1 }), 500);
  assert.equal(retryDelayMs(10, null, { baseDelayMs: 500, maxDelayMs: 16_000, random: () => 1 }), 16_000);
  assert.equal(retryDelayMs(0, '120', { maxDelayMs: 16_000 }), 16_000, 'header lớn vẫn bị kẹp trần');
});

test('timeout: fetch treo quá timeoutMs thì lỗi ETIMEDOUT và được thử lại khi idempotent', async () => {
  let calls = 0;
  const hang = (url, init) =>
    new Promise((resolve, reject) => {
      calls++;
      if (calls === 2) return resolve(res({ body: '{"ok":true}' }));
      init.signal.addEventListener('abort', () => reject(init.signal.reason));
    });
  const out = await request({ url: 'https://x.test', fetchImpl: hang, retries: 1, timeoutMs: 20, sleepImpl: async () => {} });
  assert.deepEqual(out, { ok: true });
  assert.equal(calls, 2);

  calls = 0;
  await assert.rejects(
    request({ url: 'https://x.test', fetchImpl: hang, retries: 0, timeoutMs: 20 }),
    (e) => e instanceof TimeoutError && e.code === 'ETIMEDOUT',
  );
});

test('timeoutMs <= 0: không gắn AbortSignal (không timeout)', async () => {
  const seen = [];
  const capture = async (url, init) => { seen.push(init); return res({ body: '{"ok":true}' }); };
  assert.deepEqual(await request({ url: 'https://x.test', fetchImpl: capture, timeoutMs: 0 }), { ok: true });
  assert.equal(seen[0].signal, undefined);
  await request({ url: 'https://x.test', fetchImpl: capture, timeoutMs: 50 });
  assert.ok(seen[1].signal, 'timeout dương vẫn có signal');
});

test('request KHÔNG idempotent: timeout → UNCERTAIN_WRITE không thử lại; 429 vẫn thử lại', async () => {
  let calls = 0;
  const hang = (url, init) => new Promise((_, reject) => { calls++; init.signal.addEventListener('abort', () => reject(init.signal.reason)); });
  await assert.rejects(
    request({ url: 'https://x.test', method: 'POST', fetchImpl: hang, retries: 3, timeoutMs: 20, idempotent: false, sleepImpl: async () => {} }),
    (e) => e instanceof UncertainWriteError && e.code === 'UNCERTAIN_WRITE' && e.cause instanceof TimeoutError,
  );
  assert.equal(calls, 1, 'không được gửi lại một request có thể đã ghi');

  calls = 0;
  const throttled = async () => (++calls === 1 ? res({ ok: false, status: 429, body: '{}' }) : res({ body: '{}' }));
  await request({ url: 'https://x.test', method: 'POST', fetchImpl: throttled, retries: 3, idempotent: false, sleepImpl: async () => {} });
  assert.equal(calls, 2);
});

test('isRetryable: phân loại đúng theo idempotent', () => {
  const e503 = new GoogleApiError(503, {});
  const e403rl = new GoogleApiError(403, { error: { errors: [{ reason: 'rateLimitExceeded' }] } });
  const e403 = new GoogleApiError(403, { error: { errors: [{ reason: 'forbidden' }] } });
  const net = new TypeError('fetch failed');
  assert.equal(isRetryable(e503, { idempotent: true }), true);
  assert.equal(isRetryable(e503, { idempotent: false }), true);
  assert.equal(isRetryable(e403rl, { idempotent: false }), true);
  assert.equal(isRetryable(e403, { idempotent: true }), false);
  assert.equal(isRetryable(net, { idempotent: true }), true);
  assert.equal(isRetryable(net, { idempotent: false }), false);
});

test('createLimiter: không quá N việc chạy cùng lúc', async () => {
  const limit = createLimiter(2);
  let active = 0, peak = 0;
  const job = () => limit(async () => { active++; peak = Math.max(peak, active); await new Promise((r) => setTimeout(r, 5)); active--; return 1; });
  const out = await Promise.all([job(), job(), job(), job(), job()]);
  assert.equal(out.length, 5);
  assert.equal(peak, 2);
});

test('UncertainWriteError KHÔNG bị coi là tạm thời dù message chứa lỗi mạng', () => {
  const err = new UncertainWriteError(new TypeError('fetch failed'));
  assert.equal(isTransient(err), false);
  assert.equal(isRetryable(err, { idempotent: true }), false);
  assert.equal(isRetryable(err, { idempotent: false }), false);
});

test('timeout khi đang đọc body cũng thành TimeoutError (cả nhánh lỗi lẫn nhánh thành công)', async () => {
  const abort = () => Promise.reject(new DOMException('The operation was aborted due to timeout', 'TimeoutError'));
  const okSlow = async () => ({ ...res({ body: '{}' }), text: abort });
  await assert.rejects(
    request({ url: 'https://x.test', fetchImpl: okSlow }),
    (e) => e instanceof TimeoutError && e.code === 'ETIMEDOUT',
  );
  const errSlow = async () => ({ ...res({ ok: false, status: 500 }), text: abort });
  await assert.rejects(
    request({ url: 'https://x.test', fetchImpl: errSlow }),
    (e) => e instanceof TimeoutError && e.code === 'ETIMEDOUT',
  );
});
