# Kế hoạch triển khai v0.4.0: giới hạn theo folder, ít token, chạy ổn định

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Trợ lý AI chỉ đọc/ghi được trong các folder Drive người dùng chỉ định, với bộ 5 tool trả văn bản nén, request có timeout/retry đúng và cache metadata.

**Architecture:** Thêm lớp `scope` (danh sách folder + lần theo folder cha, có cache) đứng trước mọi tool; viết lại `tools.mjs` thành 5 tool trả chuỗi thuần; `http.mjs` thêm timeout, retry theo `Retry-After`, phân biệt request idempotent; metadata Drive/Sheets đi qua TTL cache trong tiến trình server. CLI thêm nhóm `folder`. Bộ đọc OOXML sửa 3 lỗi dữ liệu.

**Tech Stack:** Node.js >= 18.17, chỉ API có sẵn (`node:crypto`, `node:zlib`, `fetch`, `AbortSignal.timeout`), test bằng `node --test`.

**Spec:** `docs/superpowers/specs/2026-10-01-folder-scoped-design.md`

## Global Constraints

- Node.js >= 18.17; không thêm dependency.
- Stdout của MCP server chỉ chứa frame JSON-RPC; `console.log` đã chuyển sang stderr ở dòng đầu `server/index.mjs`.
- Private key chỉ nằm trong đúng một file config, mode 600; không in ra log, kết quả tool, hay config của client.
- Tool ghi chỉ xuất hiện khi có ít nhất một folder `access: write`.
- Danh sách folder rỗng thì mọi tool từ chối truy cập.
- Tổng schema tool dưới 700 token ước lượng (`ceil(bytes/3.5)`), CI báo đỏ nếu vượt.
- Đường dẫn dùng `path.join`; test chạy trên Windows (CRLF, `%APPDATA%`).
- Test không gọi mạng, không đọc config thật (HOME tạm, `fetchImpl` giả).
- Commit theo Conventional Commits, kết thúc bằng `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- Nhánh làm việc tách từ `develop`; PR nhắm vào `develop`.

## Review Focus

1. Sheet có hai cột trùng tên header: `columns`/`where` phải lấy cột đầu tiên, không lỗi và không lấy nhầm cột sau. → test trong Task 6.
2. File shortcut (`application/vnd.google-apps.shortcut`) nằm trong folder được phép nhưng trỏ tới file ngoài phạm vi: phải bị từ chối, không được đọc file đích. → test trong Task 4.
3. File có nhiều `parents`, một nằm trong phạm vi: phải được coi là trong phạm vi. → test trong Task 4.
4. Hàng Sheets ngắn hơn header (API trả hàng ragged): TSV phải đệm ô rỗng, không lệch cột. → test trong Task 6.
5. `limit` vượt 2000 hoặc âm, `offset` âm: phải kẹp về biên, không ném lỗi, không trả cả bảng. → test trong Task 6.

---

## Thứ tự và phụ thuộc

| Task | Nội dung | Phụ thuộc |
|---|---|---|
| 1 | `http.mjs`: timeout, Retry-After, 403 giới hạn tốc độ, idempotent, debug | — |
| 2 | `client.mjs`: giới hạn đồng thời, bỏ `credentials` khỏi public API | 1 |
| 3 | `config.mjs` ghi atomic; `folders.mjs` | — |
| 4 | `cache.mjs`, `meta.mjs`, `scope.mjs` | 3 |
| 5 | `table-view.mjs`, `render.mjs` | — |
| 6 | Test Review Focus cho view (gộp vào 5) | 5 |
| 7 | Kiểm chứng API thật phần ghi (cần folder thử của người dùng) | 2 |
| 8 | `drive.mjs` + `sheets.mjs`: `updateFile`, `idempotent`, `meta` truyền vào `read-document.mjs`, giới hạn 50 MB | 1, 2 |
| 9 | `tools.mjs` 5 tool mới, `server/index.mjs`, `instructions.mjs` | 4, 5, 8 |
| 10 | CLI `folder add/list/remove/set`, scope cho `read/doc/ls/write` | 3, 4 |
| 11 | OOXML: pptx theo `sldIdLst`, docx số âm, xlsx `r:id`, zip `maxOutputLength` | — |
| 12 | `bench/tokens.mjs` + CI gate; dọn trùng lặp `nodeOk` | 9 |
| 13 | Skill, README, CHANGELOG, bump 0.4.0 | tất cả |

Task 11 độc lập, làm song song được. Task 7 cần người dùng; không chặn Task 9 phần đọc, chỉ chặn `drive_create` và `drive_move`.

---

### Task 1: `http.mjs` — timeout, Retry-After, 403 giới hạn tốc độ, idempotent, debug

**Files:**
- Modify: `src/http.mjs`
- Test: `test/http.test.mjs`

**Interfaces:**
- Consumes: không.
- Produces:
  - `request(opts)` nhận thêm `timeoutMs = 30_000`, `idempotent = true`, `random = Math.random`, `maxDelayMs = 16_000`.
  - `isRateLimited(error): boolean`, `isTransient(error): boolean` (giờ gồm 403 giới hạn tốc độ và timeout), `isRetryable(error, { idempotent })`, `retryDelayMs(attempt, retryAfterHeader, { baseDelayMs, maxDelayMs, random, now })`.
  - `class TimeoutError extends Error` với `code = 'ETIMEDOUT'`, `.timeoutMs`.
  - `class UncertainWriteError extends Error` với `code = 'UNCERTAIN_WRITE'`, `.cause`.
  - `GoogleApiError` có thêm `.retryAfter` (chuỗi header hoặc `null`).
  - `createLimiter(max): (fn) => Promise` (dùng ở Task 2).

- [ ] **Step 1: Viết test đỏ cho retry và timeout**

Thêm vào cuối `test/http.test.mjs` (file đã import `request`, `GoogleApiError`, `isTransient` và có helper `res({ ok, status, body, headers? })`; nếu `res` chưa nhận `headers`, sửa helper để `headers: new Headers(h.headers ?? {})`):

```js
import { createLimiter, isRetryable, retryDelayMs, TimeoutError, UncertainWriteError } from '../src/http.mjs';

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
```

Sửa test cũ `retries>0 KHÔNG thử lại lỗi vĩnh viễn (403)` (dòng ~92): body phải có `"errors":[{"reason":"forbidden"}]` để không bị coi là giới hạn tốc độ.

- [ ] **Step 2: Chạy test, xác nhận đỏ**

Run: `node --test test/http.test.mjs`
Expected: FAIL, lỗi import `createLimiter`/`isRetryable`/`TimeoutError` không tồn tại.

- [ ] **Step 3: Sửa `src/http.mjs`**

Thay phần từ `const TRANSIENT_STATUS` tới hết hàm `once` bằng:

```js
const TRANSIENT_STATUS = new Set([408, 429, 500, 502, 503, 504]);
// Google đã CHẮC CHẮN từ chối ở các mã này → request không idempotent vẫn gửi lại được.
const REJECTED_STATUS = new Set([429, 503]);
const RATE_LIMIT_REASONS = new Set(['rateLimitExceeded', 'userRateLimitExceeded', 'quotaExceeded']);
const TRANSIENT_MESSAGE_RE =
  /ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|EPIPE|ENOTFOUND|socket hang up|network ?error|fetch failed/i;

export class TimeoutError extends Error {
  constructor(url, method, timeoutMs) {
    super(`Google không trả lời sau ${timeoutMs} ms (${method} ${url}).`);
    this.name = 'TimeoutError';
    this.code = 'ETIMEDOUT';
    this.timeoutMs = timeoutMs;
  }
}

/** Request có thể đã được Google thực hiện nhưng ta không nhận được trả lời. */
export class UncertainWriteError extends Error {
  constructor(cause) {
    super(
      `Chưa chắc đã ghi: ${cause?.message ?? cause}. ` +
        'Đọc lại dữ liệu trước khi thử lại, nếu không có thể bị ghi trùng.',
    );
    this.name = 'UncertainWriteError';
    this.code = 'UNCERTAIN_WRITE';
    this.cause = cause;
  }
}

/** Drive báo vượt quota per-user bằng 403 chứ không phải 429. */
export function isRateLimited(error) {
  if (Number(error?.code) !== 403) return false;
  if (RATE_LIMIT_REASONS.has(error?.reason)) return true;
  return /rate ?limit|quota exceeded/i.test(String(error?.message ?? ''));
}

export function isTransient(error) {
  if (isRateLimited(error)) return true;
  if (error?.code === 'ETIMEDOUT' || error?.name === 'TimeoutError') return true;
  if (TRANSIENT_STATUS.has(Number(error?.code ?? error?.response?.status ?? NaN))) return true;
  return TRANSIENT_MESSAGE_RE.test(String(error?.message ?? error ?? ''));
}

/**
 * Idempotent (GET, values.batchUpdate, files.update) thử lại mọi lỗi tạm thời. Không
 * idempotent (values.append, files.create) chỉ thử lại khi Google CHẮC CHẮN đã từ chối.
 */
export function isRetryable(error, { idempotent = true } = {}) {
  if (!isTransient(error)) return false;
  if (idempotent) return true;
  return REJECTED_STATUS.has(Number(error?.code)) || isRateLimited(error);
}

function parseRetryAfter(value, now) {
  if (value == null || value === '') return null;
  const secs = Number(value);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.max(0, at - now()) : null;
}

/** Backoff mũ có jitter trong [exp/2, exp]; header Retry-After thắng nhưng vẫn bị kẹp trần. */
export function retryDelayMs(
  attempt,
  retryAfter = null,
  { baseDelayMs = 500, maxDelayMs = 16_000, random = Math.random, now = Date.now } = {},
) {
  const fromHeader = parseRetryAfter(retryAfter, now);
  if (fromHeader != null) return Math.min(fromHeader, maxDelayMs);
  const exp = Math.min(baseDelayMs * 2 ** attempt, maxDelayMs);
  return Math.round(exp / 2 + (random() * exp) / 2);
}

/** Tối đa `max` việc chạy đồng thời; việc thừa xếp hàng theo thứ tự gọi. */
export function createLimiter(max) {
  let active = 0;
  const queue = [];
  const pump = () => {
    while (active < max && queue.length) {
      active++;
      queue.shift()();
    }
  };
  return async (fn) => {
    await new Promise((resolve) => {
      queue.push(resolve);
      pump();
    });
    try {
      return await fn();
    } finally {
      active--;
      pump();
    }
  };
}

const DEBUG = process.env.GDRIVE_DEBUG === '1';
function debug(line) {
  if (DEBUG) process.stderr.write(`[gdrive-http] ${line}\n`);
}
function pathOf(url) {
  try {
    const u = new URL(url);
    return `${u.host}${u.pathname}`;
  } catch {
    return url;
  }
}

/**
 * Gọi một endpoint Google REST.
 *
 * @param {object} opts
 * @param {string} opts.url
 * @param {string} [opts.method]
 * @param {string} [opts.token]
 * @param {object|string|Uint8Array} [opts.body]
 * @param {Record<string,string>} [opts.headers]
 * @param {'json'|'buffer'|'text'|'raw'} [opts.responseType]
 * @param {number} [opts.retries]        mặc định 0 — thư viện tự retry ở tầng trên
 * @param {number} [opts.timeoutMs]      mặc định 30 giây
 * @param {boolean} [opts.idempotent]    false cho append/create: không gửi lại khi mất trả lời
 */
export async function request({
  url,
  method = 'GET',
  token,
  body,
  headers = {},
  responseType = 'json',
  retries = 0,
  baseDelayMs = 500,
  maxDelayMs = 16_000,
  timeoutMs = 30_000,
  idempotent = true,
  fetchImpl = fetch,
  sleepImpl = sleep,
  random = Math.random,
}) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const started = Date.now();
    try {
      const out = await once({ url, method, token, body, headers, responseType, timeoutMs, fetchImpl });
      debug(`${method} ${pathOf(url)} ok ${Date.now() - started}ms attempt=${attempt + 1}`);
      return out;
    } catch (error) {
      lastError = error;
      debug(`${method} ${pathOf(url)} ${error?.code ?? error?.name} ${Date.now() - started}ms attempt=${attempt + 1}`);
      const retryable = isRetryable(error, { idempotent });
      if (!retryable) {
        if (!idempotent && isTransient(error)) throw new UncertainWriteError(error);
        throw error;
      }
      if (attempt === retries) break;
      await sleepImpl(retryDelayMs(attempt, error?.retryAfter ?? null, { baseDelayMs, maxDelayMs, random }));
    }
  }
  if (!idempotent && lastError && !REJECTED_STATUS.has(Number(lastError?.code)) && !isRateLimited(lastError)) {
    throw new UncertainWriteError(lastError);
  }
  throw lastError;
}

async function once({ url, method, token, body, headers, responseType, timeoutMs, fetchImpl }) {
  const finalHeaders = { ...headers };
  if (token) finalHeaders.authorization = `Bearer ${token}`;

  let payload = body;
  const isBinary = body instanceof Uint8Array || body instanceof ArrayBuffer;
  if (body !== undefined && body !== null && !isBinary && typeof body !== 'string') {
    payload = JSON.stringify(body);
    finalHeaders['content-type'] ??= 'application/json; charset=UTF-8';
  }

  let res;
  try {
    res = await fetchImpl(url, { method, headers: finalHeaders, body: payload, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if (err?.name === 'TimeoutError' || err?.name === 'AbortError') throw new TimeoutError(url, method, timeoutMs);
    throw err;
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    let parsed = text;
    try {
      parsed = JSON.parse(text);
    } catch {
      /* giữ nguyên text */
    }
    throw new GoogleApiError(res.status, parsed, { url, method, retryAfter: res.headers?.get?.('retry-after') ?? null });
  }

  if (responseType === 'raw') return res;
  if (responseType === 'buffer') return Buffer.from(await res.arrayBuffer());
  if (responseType === 'text') return res.text();
  const text = await res.text();
  return text ? JSON.parse(text) : {};
}
```

Trong constructor `GoogleApiError`, đổi chữ ký thành `constructor(status, body, { url, method, retryAfter = null } = {})` và thêm `this.retryAfter = retryAfter;` sau `this.method = method;`.

- [ ] **Step 4: Chạy test, xác nhận xanh**

Run: `node --test test/http.test.mjs test/sheets-compat.test.mjs test/auth.test.mjs`
Expected: PASS toàn bộ. `sheets-compat.test.mjs` kiểm hợp đồng lỗi `.code` là số; không được đỏ.

- [ ] **Step 5: Commit**

```bash
git add src/http.mjs test/http.test.mjs
git commit -m "feat(http): timeout, Retry-After, retry 403 rateLimitExceeded, phân biệt request idempotent

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: `client.mjs` — giới hạn đồng thời, truyền `idempotent`/`timeoutMs`, bỏ private key khỏi public API

**Files:**
- Modify: `src/client.mjs`, `server/index.mjs` (hàm `explain`), `src/auth.mjs` (bỏ `credentials` khỏi object trả về của `createTokenSource`)
- Test: `test/client.test.mjs` (mới)

**Interfaces:**
- Consumes: `request`, `createLimiter` từ Task 1.
- Produces: `createClient({ ..., concurrency = 4, timeoutMs = 30_000 })` trả `{ api, tokenSource, scopes, mode, identity: { type, clientEmail, source } }`. `api(opts)` chuyển tiếp `idempotent`, `timeoutMs`, `responseType`.

- [ ] **Step 1: Viết test đỏ `test/client.test.mjs`**

```js
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
```

- [ ] **Step 2: Chạy test, xác nhận đỏ**

Run: `node --test test/client.test.mjs`
Expected: FAIL (`client.credentials` còn tồn tại; `concurrency` chưa có).

- [ ] **Step 3: Sửa `src/client.mjs`**

```js
// Gộp credential + token + transport thành một hàm gọi API duy nhất.

import { createTokenSource } from './auth.mjs';
import { resolveCredentials, scopesForMode } from './credentials.mjs';
import { createLimiter, request } from './http.mjs';

/**
 * @param {object} [opts]
 * @param {object} [opts.credentials]   {clientEmail, privateKey} hoặc {accessToken} — bỏ qua thì tự dò
 * @param {'readonly'|'readwrite'} [opts.mode]
 * @param {number} [opts.retries]       số lần thử lại lỗi tạm thời (CLI/MCP dùng 4, thư viện dùng 0)
 * @param {number} [opts.concurrency]   số request Google chạy cùng lúc tối đa (mặc định 4)
 * @param {number} [opts.timeoutMs]     timeout mỗi request (mặc định 30 giây)
 * @param {boolean} [opts.allowAdc]
 */
export function createClient({
  credentials = null,
  mode = 'readwrite',
  retries = 0,
  concurrency = 4,
  timeoutMs = 30_000,
  allowAdc = false,
  env = process.env,
  home = undefined,
  fetchImpl = fetch,
  now = Date.now,
} = {}) {
  const resolved = resolveCredentials({ explicit: credentials, env, allowAdc, ...(home ? { home } : {}) });
  const scopes = scopesForMode(mode);
  const tokenSource = createTokenSource(resolved, { fetchImpl, now });
  const limit = createLimiter(concurrency);

  async function api(opts) {
    const headers = { ...(opts.headers ?? {}) };
    // ADC của người dùng cần quota project, nếu không Google trả 403 SERVICE_DISABLED.
    if (tokenSource.quotaProjectId) headers['x-goog-user-project'] = tokenSource.quotaProjectId;

    const send = async () => {
      const token = await tokenSource.getToken(scopes);
      return request({ retries, timeoutMs, ...opts, token, headers, fetchImpl });
    };

    return limit(async () => {
      try {
        return await send();
      } catch (err) {
        // Token bị thu hồi giữa chừng (xoay key, gcloud logout). Vứt cache, thử đúng 1 lần.
        if (Number(err?.code) === 401) {
          tokenSource.invalidate(scopes);
          return send();
        }
        throw err;
      }
    });
  }

  // Không trả `resolved` ra ngoài: nó chứa private key, và JSON.stringify(client) sẽ in ra.
  const identity = { type: resolved.type, clientEmail: resolved.clientEmail ?? null, source: resolved.source ?? null };
  return { api, tokenSource, scopes, mode, identity };
}
```

Trong `src/auth.mjs`, object trả về của `createTokenSource` bỏ dòng `credentials,` (giữ `quotaProjectId`, `getToken`, `invalidate`).

Trong `server/index.mjs` hàm `explain`: đổi `const email = snapshot.client?.credentials?.clientEmail;` thành `const email = snapshot.client?.identity?.clientEmail;`.

Chạy `grep -rn "\.credentials\b" src bin server test` và sửa mọi chỗ còn đọc `client.credentials` hoặc `tokenSource.credentials` sang `identity`.

- [ ] **Step 4: Chạy toàn bộ test**

Run: `node --test`
Expected: PASS. Nếu `test/credentials.test.mjs` có ca đọc `client.credentials`, sửa sang `client.identity`.

- [ ] **Step 5: Commit**

```bash
git add src/client.mjs src/auth.mjs server/index.mjs test/client.test.mjs test/credentials.test.mjs
git commit -m "feat(client): giới hạn 4 request đồng thời, chuyển tiếp idempotent/timeout, bỏ private key khỏi public API

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: `config.mjs` ghi atomic; `folders.mjs` — danh sách folder và biến `GDRIVE_FOLDERS`

**Files:**
- Modify: `src/config.mjs` (hàm `writeConfig`)
- Create: `src/folders.mjs`
- Test: `test/install.test.mjs` (thêm), `test/folders.test.mjs` (mới)

**Interfaces:**
- Produces (`src/folders.mjs`):
  - `FOLDER_NAME_RE = /^[a-z0-9][a-z0-9-]{0,62}$/`
  - `slugify(name): string`
  - `parseFoldersEnv(value: string): Folder[]` với `Folder = { id: string, name: string, access: 'read'|'write' }`
  - `validateFolders(list): Folder[]` (ném `FolderConfigError`, `code = 'FOLDER_CONFIG'`)
  - `loadFolders({ config, env }): Folder[]` (env `GDRIVE_FOLDERS` thắng `config.folders`)
  - `addFolder(list, folder)`, `removeFolder(list, name)`, `setAccess(list, name, access)`: hàm thuần, trả danh sách mới.

- [ ] **Step 1: Test đỏ cho `writeConfig` atomic (thêm vào `test/install.test.mjs`)**

```js
import { readdirSync } from 'node:fs';
import { writeConfig } from '../src/config.mjs';

test('writeConfig: không để lại file tạm, file cuối có mode 600 ngay từ đầu, ghi đè nguyên tử', async () => {
  await sandbox(async ({ home, env }) => {
    const file = writeConfig({ clientEmail: 'a@x.com', privateKey: 'k1' }, home, env);
    const again = writeConfig({ clientEmail: 'a@x.com', privateKey: 'k2' }, home, env);
    assert.equal(file, again);
    assert.deepEqual(readdirSync(join(file, '..')), ['config.json'], 'không còn file .tmp');
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).privateKey, 'k2');
    if (process.platform !== 'win32') assert.equal(statSync(file).mode & 0o777, 0o600);
  });
});
```

- [ ] **Step 2: Test đỏ `test/folders.test.mjs`**

```js
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { addFolder, loadFolders, parseFoldersEnv, removeFolder, setAccess, slugify, validateFolders } from '../src/folders.mjs';

test('slugify: bỏ dấu tiếng Việt, thường hoá, thay ký tự lạ bằng -, tối đa 63', () => {
  assert.equal(slugify('Báo cáo Q3 / 2026'), 'bao-cao-q3-2026');
  assert.equal(slugify('  Đội QC  '), 'doi-qc');
  assert.equal(slugify('x'.repeat(100)).length, 63);
  assert.equal(slugify('!!!'), 'folder');
});

test('parseFoldersEnv: "name=id:access,…", access mặc định read', () => {
  assert.deepEqual(parseFoldersEnv('test-run=1XyZ:write, bao-cao=1AbC'), [
    { name: 'test-run', id: '1XyZ', access: 'write' },
    { name: 'bao-cao', id: '1AbC', access: 'read' },
  ]);
  assert.deepEqual(parseFoldersEnv(''), []);
});

test('validateFolders: từ chối tên sai, access lạ, trùng tên, trùng id', () => {
  const ok = [{ name: 'a', id: '1', access: 'read' }];
  assert.deepEqual(validateFolders(ok), ok);
  for (const bad of [
    [{ name: 'Có Dấu', id: '1', access: 'read' }],
    [{ name: 'a', id: '1', access: 'admin' }],
    [{ name: 'a', id: '1', access: 'read' }, { name: 'a', id: '2', access: 'read' }],
    [{ name: 'a', id: '1', access: 'read' }, { name: 'b', id: '1', access: 'read' }],
    [{ name: 'a', access: 'read' }],
  ]) {
    assert.throws(() => validateFolders(bad), (e) => e.code === 'FOLDER_CONFIG', JSON.stringify(bad));
  }
});

test('loadFolders: env thắng config; không có gì thì []', () => {
  const config = { folders: [{ name: 'c', id: '9', access: 'write' }] };
  assert.deepEqual(loadFolders({ config, env: {} }), config.folders);
  assert.deepEqual(loadFolders({ config, env: { GDRIVE_FOLDERS: 'e=8:read' } }), [{ name: 'e', id: '8', access: 'read' }]);
  assert.deepEqual(loadFolders({ config: null, env: {} }), []);
  assert.deepEqual(loadFolders({ config: { mode: 'readwrite' }, env: {} }), [], 'khoá mode cũ không tạo folder');
});

test('addFolder / removeFolder / setAccess là hàm thuần và giữ thứ tự', () => {
  const a = [{ name: 'a', id: '1', access: 'read' }];
  const b = addFolder(a, { name: 'b', id: '2', access: 'write' });
  assert.equal(a.length, 1);
  assert.deepEqual(b.map((f) => f.name), ['a', 'b']);
  assert.throws(() => addFolder(b, { name: 'a', id: '3', access: 'read' }), /đã có/);
  assert.deepEqual(setAccess(b, 'a', 'write')[0].access, 'write');
  assert.throws(() => setAccess(b, 'zzz', 'read'), /không có folder/);
  assert.deepEqual(removeFolder(b, 'a').map((f) => f.name), ['b']);
});
```

- [ ] **Step 3: Chạy, xác nhận đỏ**

Run: `node --test test/folders.test.mjs test/install.test.mjs`
Expected: FAIL (module `folders.mjs` chưa có; `writeConfig` chưa export/ghi tạm).

- [ ] **Step 4: Sửa `writeConfig` trong `src/config.mjs`**

Thêm `renameSync` vào import từ `node:fs`, rồi thay thân hàm:

```js
export function writeConfig(cfg, home = homedir(), env = process.env) {
  const file = writeTargetPath(home, env);
  const body = `${JSON.stringify(cfg, null, 2)}\n`;
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  // Ghi file tạm cùng thư mục rồi rename: server đang chạy không bao giờ đọc được file dở,
  // và file chứa private key có mode 600 ngay từ byte đầu tiên thay vì theo umask rồi chmod.
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, body, { mode: 0o600 });
  renameSync(tmp, file);
  if (process.platform !== 'win32') chmodSync(file, 0o600);
  return file;
}
```

- [ ] **Step 5: Tạo `src/folders.mjs`**

```js
// Danh sách folder được phép — lớp phạm vi của plugin.
//
// Mỗi folder có tên gợi nhớ (model gọi `drive_ls test-run` thay vì dán id) và quyền
// read|write. Nguồn: khoá `folders` trong config, hoặc biến GDRIVE_FOLDERS cho CI
// ("name=id:access,name2=id2"). Env thắng config để pipeline không phải sửa file.

export const FOLDER_NAME_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
export const ACCESS_LEVELS = ['read', 'write'];

export class FolderConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'FolderConfigError';
    this.code = 'FOLDER_CONFIG';
  }
}

/** Tên folder trên Drive → tên gợi nhớ hợp lệ. Rỗng thì trả 'folder'. */
export function slugify(name) {
  const slug = String(name ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'd')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63)
    .replace(/-+$/g, '');
  return slug || 'folder';
}

export function parseFoldersEnv(value) {
  return String(value ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((item) => {
      const eq = item.indexOf('=');
      if (eq < 1) throw new FolderConfigError(`GDRIVE_FOLDERS: mục "${item}" phải có dạng name=id[:access].`);
      const name = item.slice(0, eq).trim();
      const [id, access = 'read'] = item.slice(eq + 1).split(':').map((s) => s.trim());
      return { name, id, access };
    });
}

export function validateFolders(list) {
  if (!Array.isArray(list)) throw new FolderConfigError('folders phải là một mảng.');
  const names = new Set();
  const ids = new Set();
  for (const f of list) {
    if (!f || typeof f.id !== 'string' || !f.id) throw new FolderConfigError('Folder thiếu id.');
    if (!FOLDER_NAME_RE.test(String(f.name))) {
      throw new FolderConfigError(`Tên "${f.name}" không hợp lệ: chỉ a-z, 0-9 và dấu -, tối đa 63 ký tự.`);
    }
    if (!ACCESS_LEVELS.includes(f.access)) throw new FolderConfigError(`access của "${f.name}" phải là read hoặc write.`);
    if (names.has(f.name)) throw new FolderConfigError(`Tên "${f.name}" bị trùng.`);
    if (ids.has(f.id)) throw new FolderConfigError(`Folder id ${f.id} xuất hiện hai lần.`);
    names.add(f.name);
    ids.add(f.id);
  }
  return list;
}

export function loadFolders({ config = null, env = process.env } = {}) {
  if (env.GDRIVE_FOLDERS) return validateFolders(parseFoldersEnv(env.GDRIVE_FOLDERS));
  return validateFolders(Array.isArray(config?.folders) ? config.folders : []);
}

export function addFolder(list, folder) {
  if (list.some((f) => f.name === folder.name)) throw new FolderConfigError(`Tên "${folder.name}" đã có. Chọn --name khác.`);
  if (list.some((f) => f.id === folder.id)) throw new FolderConfigError(`Folder này đã có trong danh sách (tên "${list.find((f) => f.id === folder.id).name}").`);
  return validateFolders([...list, folder]);
}

function mustFind(list, name) {
  if (!list.some((f) => f.name === name)) {
    throw new FolderConfigError(`Không có folder tên "${name}". Có: ${list.map((f) => f.name).join(', ') || '(trống)'}.`);
  }
}

export function removeFolder(list, name) {
  mustFind(list, name);
  return list.filter((f) => f.name !== name);
}

export function setAccess(list, name, access) {
  mustFind(list, name);
  return validateFolders(list.map((f) => (f.name === name ? { ...f, access } : f)));
}
```

- [ ] **Step 6: Chạy test, xác nhận xanh**

Run: `node --test test/folders.test.mjs test/install.test.mjs`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/config.mjs src/folders.mjs test/folders.test.mjs test/install.test.mjs
git commit -m "feat(config): ghi config nguyên tử mode 600; thêm folders.mjs cho danh sách folder được phép

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: `cache.mjs`, `meta.mjs`, `scope.mjs` — cache TTL, metadata, phạm vi folder

**Files:**
- Create: `src/cache.mjs`, `src/meta.mjs`, `src/scope.mjs`
- Test: `test/scope.test.mjs` (mới), `test/cache.test.mjs` (mới)

**Interfaces:**
- Consumes: `getFile`, `listFiles` từ `src/drive.mjs`; `getMetadata` từ `src/sheets.mjs`; `parseGoogleUrl` từ `src/url.mjs`; `Folder[]` từ Task 3.
- Produces:
  - `createTtlCache({ ttlMs, now = Date.now, max = 2000 })` → `{ get(key), set(key, value), delete(key), clear(), getOrLoad(key, loader) }`. `getOrLoad` dedupe loader đang chạy cho cùng key.
  - `createMetaStore({ client, now })` → `{ file(id), sheet(id), findChild(parentId, name), invalidate(id), clear() }`. `file(id)` trả `{ id, name, mimeType, size, parents, driveId, modifiedTime, webViewLink, shortcutDetails }` (TTL 5 phút). `sheet(id)` trả kết quả `getMetadata` (TTL 5 phút).
  - `ScopeError` với `code` ∈ `NO_FOLDERS | OUT_OF_SCOPE | READ_ONLY | NOT_FOUND`.
  - `createScope({ folders, meta, now })` → `{ list(), hasWrite(), resolve(input), assertWrite(fileId), invalidateAll() }`. `resolve(input)` trả `{ fileId, gid, root, meta }`.

- [ ] **Step 1: Test đỏ `test/cache.test.mjs`**

```js
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createTtlCache } from '../src/cache.mjs';

test('TTL cache: hết hạn theo now(), getOrLoad dedupe loader đang chạy', async () => {
  let t = 1000;
  const cache = createTtlCache({ ttlMs: 100, now: () => t });
  cache.set('a', 1);
  assert.equal(cache.get('a'), 1);
  t += 101;
  assert.equal(cache.get('a'), undefined);

  let loads = 0;
  const loader = () => new Promise((r) => setTimeout(() => r(++loads), 5));
  const [x, y] = await Promise.all([cache.getOrLoad('b', loader), cache.getOrLoad('b', loader)]);
  assert.equal(x, 1);
  assert.equal(y, 1);
  assert.equal(loads, 1);
  assert.equal(await cache.getOrLoad('b', loader), 1, 'đã cache thì không load lại');
});

test('TTL cache: loader lỗi không để lại entry hỏng; max entries bỏ cái cũ nhất', async () => {
  const cache = createTtlCache({ ttlMs: 1000, max: 2 });
  await assert.rejects(cache.getOrLoad('x', async () => { throw new Error('boom'); }));
  assert.equal(await cache.getOrLoad('x', async () => 7), 7);
  cache.set('y', 1);
  cache.set('z', 1);
  assert.equal(cache.get('x'), undefined, 'x là entry cũ nhất, bị đẩy ra');
});
```

- [ ] **Step 2: Test đỏ `test/scope.test.mjs`**

Dùng meta store giả: một bản đồ `id → {name, mimeType, parents, shortcutDetails?}`.

```js
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createScope, ScopeError } from '../src/scope.mjs';

const FOLDER = 'application/vnd.google-apps.folder';
const SHEET = 'application/vnd.google-apps.spreadsheet';
const SHORTCUT = 'application/vnd.google-apps.shortcut';

// Cây giả:
//   rootA (write) ── sub ── fileInSub (sheet)
//   rootB (read)  ── fileB
//   outside ── fileOut ; shortcutToOut nằm trong rootA trỏ tới fileOut
//   multi: parents [outside, rootB]
const TREE = {
  rootA: { name: 'Test Run', mimeType: FOLDER, parents: [] },
  sub: { name: 'sub', mimeType: FOLDER, parents: ['rootA'] },
  fileInSub: { name: 'TC_login', mimeType: SHEET, parents: ['sub'] },
  rootB: { name: 'Bao cao', mimeType: FOLDER, parents: [] },
  fileB: { name: 'report.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', parents: ['rootB'] },
  outside: { name: 'Khac', mimeType: FOLDER, parents: [] },
  fileOut: { name: 'secret', mimeType: SHEET, parents: ['outside'] },
  shortcutToOut: { name: 'link', mimeType: SHORTCUT, parents: ['rootA'], shortcutDetails: { targetId: 'fileOut', targetMimeType: SHEET } },
  multi: { name: 'multi', mimeType: SHEET, parents: ['outside', 'rootB'] },
  loopA: { name: 'la', mimeType: FOLDER, parents: ['loopB'] },
  loopB: { name: 'lb', mimeType: FOLDER, parents: ['loopA'] },
};

function fakeMeta() {
  const calls = [];
  return {
    calls,
    async file(id) {
      calls.push(`file:${id}`);
      const m = TREE[id];
      if (!m) { const e = new Error('not found'); e.code = 404; throw e; }
      return { id, ...m };
    },
    async findChild(parentId, name) {
      calls.push(`child:${parentId}/${name}`);
      const id = Object.keys(TREE).find((k) => TREE[k].parents.includes(parentId) && TREE[k].name === name);
      return id ? { id, ...TREE[id] } : null;
    },
    invalidate() {},
    clear() {},
  };
}

const FOLDERS = [
  { name: 'test-run', id: 'rootA', access: 'write' },
  { name: 'bao-cao', id: 'rootB', access: 'read' },
];

test('danh sách rỗng → NO_FOLDERS cho mọi resolve', async () => {
  const scope = createScope({ folders: [], meta: fakeMeta() });
  await assert.rejects(scope.resolve('fileInSub12345'), (e) => e instanceof ScopeError && e.code === 'NO_FOLDERS');
  assert.equal(scope.hasWrite(), false);
});

test('file trong folder con ở độ sâu 2 thuộc phạm vi; file ngoài bị từ chối kể cả khi đọc được', async () => {
  const meta = fakeMeta();
  const scope = createScope({ folders: FOLDERS, meta });
  const r = await scope.resolve('https://docs.google.com/spreadsheets/d/fileInSub/edit#gid=7');
  assert.equal(r.fileId, 'fileInSub');
  assert.equal(r.gid, '7');
  assert.equal(r.root.name, 'test-run');
  assert.equal(r.meta.name, 'TC_login');
  await assert.rejects(scope.resolve('fileOut'), (e) => e.code === 'OUT_OF_SCOPE' && /test-run, bao-cao/.test(e.message));
});

test('cache tổ tiên: resolve lần hai cùng file không gọi file() cho tổ tiên nữa', async () => {
  const meta = fakeMeta();
  const scope = createScope({ folders: FOLDERS, meta });
  await scope.resolve('fileInSub');
  const before = meta.calls.length;
  await scope.resolve('fileInSub');
  assert.equal(meta.calls.slice(before).filter((c) => c === 'file:sub' || c === 'file:rootA').length, 0);
});

test('assertWrite: folder read → READ_ONLY; folder write → ok', async () => {
  const scope = createScope({ folders: FOLDERS, meta: fakeMeta() });
  await assert.rejects(scope.assertWrite('fileB'), (e) => e.code === 'READ_ONLY' && /bao-cao/.test(e.message));
  assert.equal((await scope.assertWrite('fileInSub')).name, 'test-run');
});

test('alias và đường dẫn: "test-run" là chính folder, "test-run/sub/TC_login" đi qua findChild', async () => {
  const meta = fakeMeta();
  const scope = createScope({ folders: FOLDERS, meta });
  assert.equal((await scope.resolve('test-run')).fileId, 'rootA');
  const r = await scope.resolve('test-run/sub/TC_login');
  assert.equal(r.fileId, 'fileInSub');
  await assert.rejects(scope.resolve('test-run/khong-co'), (e) => e.code === 'NOT_FOUND');
});

test('shortcut trong phạm vi trỏ ra ngoài → OUT_OF_SCOPE (Review Focus 2)', async () => {
  const scope = createScope({ folders: FOLDERS, meta: fakeMeta() });
  await assert.rejects(scope.resolve('shortcutToOut'), (e) => e.code === 'OUT_OF_SCOPE');
});

test('nhiều parents, một nằm trong phạm vi → thuộc phạm vi (Review Focus 3)', async () => {
  const scope = createScope({ folders: FOLDERS, meta: fakeMeta() });
  assert.equal((await scope.resolve('multi')).root.name, 'bao-cao');
});

test('vòng parents không treo: dừng ở độ sâu 32 và báo OUT_OF_SCOPE', async () => {
  const scope = createScope({ folders: FOLDERS, meta: fakeMeta() });
  await assert.rejects(scope.resolve('loopA'), (e) => e.code === 'OUT_OF_SCOPE');
});

test('invalidateAll: sau khi xoá cache, tổ tiên được tra lại', async () => {
  const meta = fakeMeta();
  const scope = createScope({ folders: FOLDERS, meta });
  await scope.resolve('fileInSub');
  scope.invalidateAll();
  const before = meta.calls.length;
  await scope.resolve('fileInSub');
  assert.ok(meta.calls.slice(before).includes('file:sub'));
});
```

- [ ] **Step 3: Chạy, xác nhận đỏ**

Run: `node --test test/cache.test.mjs test/scope.test.mjs`
Expected: FAIL (module chưa có).

- [ ] **Step 4: Tạo `src/cache.mjs`**

```js
// Cache TTL trong tiến trình. Dùng cho metadata Drive/Sheets và kết quả lần theo folder cha,
// để lần đọc lặp lại một file không tốn thêm vòng mạng.

export function createTtlCache({ ttlMs, now = Date.now, max = 2000 } = {}) {
  const store = new Map(); // key → { value, expiresAt }
  const inflight = new Map(); // key → Promise

  const alive = (entry) => entry && entry.expiresAt > now();

  function set(key, value) {
    store.delete(key);
    store.set(key, { value, expiresAt: now() + ttlMs });
    // Map giữ thứ tự chèn: entry đầu là cũ nhất.
    while (store.size > max) store.delete(store.keys().next().value);
  }

  return {
    get(key) {
      const entry = store.get(key);
      if (alive(entry)) return entry.value;
      store.delete(key);
      return undefined;
    },
    set,
    delete: (key) => {
      store.delete(key);
      inflight.delete(key);
    },
    clear: () => {
      store.clear();
      inflight.clear();
    },
    async getOrLoad(key, loader) {
      const hit = this.get(key);
      if (hit !== undefined) return hit;
      if (inflight.has(key)) return inflight.get(key);
      const p = (async () => {
        try {
          const value = await loader();
          set(key, value);
          return value;
        } finally {
          inflight.delete(key);
        }
      })();
      inflight.set(key, p);
      return p;
    },
  };
}
```

- [ ] **Step 5: Tạo `src/meta.mjs`**

```js
// Metadata Drive/Sheets đi qua cache 5 phút. Mọi tool lấy metadata ở đây, không gọi
// getFile/getMetadata trực tiếp — nhờ vậy đọc lặp lại một sheet chỉ còn 1 request.

import { createTtlCache } from './cache.mjs';
import { getFile, listFiles } from './drive.mjs';
import { getMetadata } from './sheets.mjs';

export const META_FIELDS = 'id,name,mimeType,size,parents,driveId,modifiedTime,webViewLink,shortcutDetails';
const TTL_MS = 5 * 60_000;

export function createMetaStore({ client, now = Date.now, ttlMs = TTL_MS } = {}) {
  const files = createTtlCache({ ttlMs, now });
  const sheets = createTtlCache({ ttlMs, now });
  return {
    file: (id) => files.getOrLoad(id, () => getFile(client, id, { fields: META_FIELDS })),
    sheet: (id) => sheets.getOrLoad(id, () => getMetadata(client, id)),
    /** Con trực tiếp tên đúng `name` (so khớp chính xác phía client, Drive chỉ có `contains`). */
    async findChild(parentId, name) {
      const { files: found } = await listFiles(client, { folderId: parentId, nameContains: name, max: 100 });
      const exact = found.find((f) => f.name === name);
      if (!exact) return null;
      files.set(exact.id, exact);
      return exact;
    },
    invalidate(id) {
      files.delete(id);
      sheets.delete(id);
    },
    clear() {
      files.clear();
      sheets.clear();
    },
  };
}
```

- [ ] **Step 6: Tạo `src/scope.mjs`**

```js
// Lớp phạm vi: một file chỉ được đọc/ghi khi nó, hoặc một tổ tiên theo `parents`, là
// folder trong danh sách. Kết quả lần theo tổ tiên cache 10 phút.
//
// Shortcut được coi là file ĐÍCH của nó: shortcut nằm trong folder được phép nhưng trỏ ra
// ngoài vẫn bị từ chối — nếu không, một shortcut do ai đó tạo là đủ để đọc file lạ.

import { createTtlCache } from './cache.mjs';
import { FOLDER_NAME_RE } from './folders.mjs';
import { parseGoogleUrl } from './url.mjs';

const MIME_FOLDER = 'application/vnd.google-apps.folder';
const MIME_SHORTCUT = 'application/vnd.google-apps.shortcut';
const MAX_DEPTH = 32;
const TTL_MS = 10 * 60_000;

export class ScopeError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ScopeError';
    this.code = code;
  }
}

export function createScope({ folders, meta, now = Date.now, ttlMs = TTL_MS }) {
  const byId = new Map(folders.map((f) => [f.id, f]));
  const byName = new Map(folders.map((f) => [f.name, f]));
  const roots = createTtlCache({ ttlMs, now }); // fileId → root folder | null
  const names = () => folders.map((f) => f.name).join(', ') || '(trống)';

  function requireFolders() {
    if (!folders.length) {
      throw new ScopeError('NO_FOLDERS', 'Chưa có folder nào được phép. Chạy: gdrive folder add <url-folder> [--access write]');
    }
  }

  /** Folder gốc chứa `id`, hoặc null. Cache cho mọi id đi qua trên đường lên. */
  async function rootOf(id, depth = 0, seen = new Set()) {
    if (byId.has(id)) return byId.get(id);
    const cached = roots.get(id);
    if (cached !== undefined) return cached;
    if (depth >= MAX_DEPTH || seen.has(id)) return null;
    seen.add(id);

    const m = await meta.file(id);
    let root = null;
    for (const parent of m.parents ?? []) {
      root = await rootOf(parent, depth + 1, seen);
      if (root) break;
    }
    roots.set(id, root);
    return root;
  }

  async function resolveTarget(id) {
    let m = await meta.file(id);
    if (m.mimeType === MIME_SHORTCUT && m.shortcutDetails?.targetId) {
      m = await meta.file(m.shortcutDetails.targetId);
    }
    const root = await rootOf(m.id);
    if (!root) throw new ScopeError('OUT_OF_SCOPE', `Ngoài phạm vi: "${m.name}" không thuộc folder nào được phép (${names()}).`);
    return { fileId: m.id, root, meta: m };
  }

  async function resolvePath(input) {
    const [alias, ...rest] = input.split('/').filter(Boolean);
    let current = { id: byName.get(alias).id, name: alias, mimeType: MIME_FOLDER };
    for (const segment of rest) {
      if (current.mimeType !== MIME_FOLDER) throw new ScopeError('NOT_FOUND', `"${current.name}" không phải folder.`);
      const child = await meta.findChild(current.id, segment);
      if (!child) throw new ScopeError('NOT_FOUND', `Không có "${segment}" trong ${alias}${rest.length > 1 ? '/' : ''}.`);
      current = child;
    }
    return { ...(await resolveTarget(current.id)), gid: null };
  }

  return {
    list: () => folders.slice(),
    hasWrite: () => folders.some((f) => f.access === 'write'),

    /** `input`: tên gợi nhớ, `tên/đường/dẫn`, URL Google hoặc id trần. */
    async resolve(input) {
      requireFolders();
      const raw = String(input ?? '').trim();
      const first = raw.split('/')[0];
      if (FOLDER_NAME_RE.test(first) && byName.has(first) && !raw.includes(':')) return resolvePath(raw);
      const { id, gid } = parseGoogleUrl(raw);
      return { ...(await resolveTarget(id)), gid };
    },

    async assertWrite(fileId) {
      requireFolders();
      const root = await rootOf(fileId);
      if (!root) throw new ScopeError('OUT_OF_SCOPE', `Ngoài phạm vi: file không thuộc folder nào được phép (${names()}).`);
      if (root.access !== 'write') throw new ScopeError('READ_ONLY', `Chỉ đọc: folder "${root.name}" có quyền read. Bật ghi: gdrive folder set ${root.name} --access write`);
      return root;
    },

    invalidateAll: () => roots.clear(),
  };
}
```

- [ ] **Step 7: Chạy test, xác nhận xanh**

Run: `node --test test/cache.test.mjs test/scope.test.mjs`
Expected: PASS 11 test.

- [ ] **Step 8: Commit**

```bash
git add src/cache.mjs src/meta.mjs src/scope.mjs test/cache.test.mjs test/scope.test.mjs
git commit -m "feat(scope): lớp phạm vi folder có cache tổ tiên; metadata store TTL 5 phút

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: `table-view.mjs` và `render.mjs` — lọc, phân trang, TSV, dòng tiêu đề, định dạng `ls`

**Files:**
- Create: `src/table-view.mjs`, `src/render.mjs`
- Test: `test/table-view.test.mjs`, `test/render.test.mjs` (mới)

**Interfaces:**
- Produces:
  - `viewTable(rows, { columns = null, where = null, offset = 0, limit = 200 })` → `{ header: string[], rows: string[][], total: number, offset: number, limit: number, next: number|null }`. Ném `ViewError` (`code = 'BAD_COLUMN'`) khi tên cột không có.
  - `toTsv(header, rows): string`
  - `typeCode(mimeType, name): string` (`d s c p x w k t f`)
  - `renderFolders(folders): string`
  - `renderLs({ title, access, items, total, next }): string`
  - `renderTable({ file, tab, tabs, view }): string` (dòng `#` + TSV)
  - `renderDoc({ file, kind, text, total, truncatedAt }): string`
  - `renderError(err, { folders }): string` (bắt đầu bằng `✗`)

- [ ] **Step 1: Test đỏ `test/table-view.test.mjs`**

```js
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { toTsv, viewTable } from '../src/table-view.mjs';

const ROWS = [
  ['ID', 'Trạng thái', 'Ghi chú', 'ID'],
  ['TC1', 'PASS', 'ok', 'dup1'],
  ['TC2', 'FAIL', 'lỗi\tcó tab', 'dup2'],
  ['TC3', 'FAIL'],                       // hàng ragged (Review Focus 4)
  ['TC4', ' PASS ', 'khoảng trắng'],
];

test('mặc định: header + mọi dòng, không next', () => {
  const v = viewTable(ROWS);
  assert.deepEqual(v.header, ROWS[0]);
  assert.equal(v.rows.length, 4);
  assert.equal(v.total, 4);
  assert.equal(v.next, null);
});

test('where so khớp sau trim, AND nhiều điều kiện; columns chiếu theo tên', () => {
  const v = viewTable(ROWS, { where: { 'Trạng thái': 'PASS' }, columns: ['ID', 'Ghi chú'] });
  assert.deepEqual(v.header, ['ID', 'Ghi chú']);
  assert.deepEqual(v.rows, [['TC1', 'ok'], ['TC4', 'khoảng trắng']]);
  assert.equal(viewTable(ROWS, { where: { 'Trạng thái': 'FAIL', ID: 'TC2' } }).rows.length, 1);
});

test('header trùng tên: lấy cột ĐẦU TIÊN (Review Focus 1)', () => {
  const v = viewTable(ROWS, { columns: ['ID'], where: { ID: 'TC1' } });
  assert.deepEqual(v.rows, [['TC1']]);
});

test('tên cột không có → BAD_COLUMN liệt kê header; so khớp không phân biệt hoa thường', () => {
  assert.throws(() => viewTable(ROWS, { columns: ['Khong co'] }), (e) => e.code === 'BAD_COLUMN' && /Trạng thái/.test(e.message));
  assert.deepEqual(viewTable(ROWS, { columns: ['trạng thái'] }).header, ['Trạng thái']);
});

test('phân trang: offset/limit trên dòng đã lọc, next đúng, biên bị kẹp (Review Focus 5)', () => {
  const p1 = viewTable(ROWS, { limit: 2 });
  assert.deepEqual(p1.rows.map((r) => r[0]), ['TC1', 'TC2']);
  assert.equal(p1.next, 2);
  const p2 = viewTable(ROWS, { offset: 2, limit: 2 });
  assert.deepEqual(p2.rows.map((r) => r[0]), ['TC3', 'TC4']);
  assert.equal(p2.next, null);
  assert.equal(viewTable(ROWS, { limit: 999_999 }).limit, 2000);
  assert.equal(viewTable(ROWS, { limit: -5, offset: -3 }).offset, 0);
  assert.equal(viewTable(ROWS, { offset: 50 }).rows.length, 0);
});

test('toTsv: đệm ô thiếu, thay tab/xuống dòng trong ô bằng dấu cách', () => {
  const v = viewTable(ROWS, { where: { ID: 'TC2' } });
  const tsv = toTsv(v.header, v.rows);
  assert.equal(tsv.split('\n').length, 2);
  assert.equal(tsv.split('\n')[1], 'TC2\tFAIL\tlỗi có tab\tdup2');
  const ragged = toTsv(['a', 'b', 'c'], [['1']]);
  assert.equal(ragged.split('\n')[1], '1\t\t');
});

test('bảng rỗng: header rỗng, 0 dòng, không ném', () => {
  const v = viewTable([]);
  assert.deepEqual(v, { header: [], rows: [], total: 0, offset: 0, limit: 200, next: null });
});
```

- [ ] **Step 2: Test đỏ `test/render.test.mjs`**

```js
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { renderDoc, renderError, renderFolders, renderLs, renderTable, typeCode } from '../src/render.mjs';
import { ScopeError } from '../src/scope.mjs';
import { viewTable } from '../src/table-view.mjs';

test('typeCode theo mimeType, rơi về đuôi tên', () => {
  assert.equal(typeCode('application/vnd.google-apps.folder'), 'd');
  assert.equal(typeCode('application/vnd.google-apps.spreadsheet'), 's');
  assert.equal(typeCode('application/vnd.google-apps.document'), 'c');
  assert.equal(typeCode('application/vnd.google-apps.presentation'), 'p');
  assert.equal(typeCode('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'), 'x');
  assert.equal(typeCode('application/octet-stream', 'a.docx'), 'w');
  assert.equal(typeCode('application/octet-stream', 'a.pptx'), 'k');
  assert.equal(typeCode('text/csv'), 't');
  assert.equal(typeCode('image/png'), 'f');
});

test('renderFolders: một dòng mỗi folder, tên và quyền', () => {
  const out = renderFolders([{ name: 'test-run', id: '1XyZ', access: 'write' }, { name: 'bao-cao', id: '1AbC', access: 'read' }]);
  assert.equal(out, '# 2 folders\nd test-run (write) 1XyZ\nd bao-cao (read) 1AbC');
});

test('renderLs: dòng đầu có tên/quyền/số lượng và next, mỗi mục một dòng', () => {
  const out = renderLs({
    title: 'test-run', access: 'write', total: 2, next: 'TOKEN',
    items: [
      { id: '1Abc', name: '2026-Q3', mimeType: 'application/vnd.google-apps.folder' },
      { id: '1Ghi', name: 'report.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', modifiedTime: '2026-09-28T10:00:00Z', size: '49152' },
    ],
  });
  assert.equal(out.split('\n')[0], '# test-run (write) · 2 · next=TOKEN');
  assert.equal(out.split('\n')[1], 'd 2026-Q3 1Abc');
  assert.equal(out.split('\n')[2], 'x report.xlsx 1Ghi 2026-09-28 48KB');
});

test('renderTable: dòng # có file, tab, tabs, rows a-b/total, next; rồi TSV', () => {
  const view = viewTable([['ID', 'S'], ['1', 'a'], ['2', 'b'], ['3', 'c']], { limit: 2 });
  const out = renderTable({ file: 'TC_login', tab: 'Sheet1', tabs: ['Sheet1', 'Data'], view });
  assert.deepEqual(out.split('\n'), ['# TC_login › Sheet1 · tabs: Sheet1,Data · rows 1-2/3 · next=2', 'ID\tS', '1\ta', '2\tb']);
  const last = renderTable({ file: 'f', tab: 't', tabs: ['t'], view: viewTable([['a'], ['1']]) });
  assert.equal(last.split('\n')[0], '# f › t · tabs: t · rows 1-1/1');
  const empty = renderTable({ file: 'f', tab: 't', tabs: ['t'], view: viewTable([['a']]) });
  assert.equal(empty.split('\n')[0], '# f › t · tabs: t · rows 0/0');
});

test('renderDoc: tiêu đề và dòng truncated khi bị cắt', () => {
  const full = renderDoc({ file: 'Guide', kind: 'docx', text: 'xin chào', total: 8, truncatedAt: null });
  assert.equal(full, '# Guide (docx) · 8 chars\nxin chào');
  const cut = renderDoc({ file: 'Guide', kind: 'docx', text: 'xin', total: 8, truncatedAt: 3 });
  assert.equal(cut.split('\n').at(-1), '# truncated at 3/8 chars');
});

test('renderError: ScopeError, 403 có email, lỗi thường', () => {
  assert.equal(renderError(new ScopeError('OUT_OF_SCOPE', 'Ngoài phạm vi: x')), '✗ Ngoài phạm vi: x');
  const e403 = Object.assign(new Error('The caller does not have permission'), { code: 403 });
  assert.match(renderError(e403, { email: 'sa@p.iam.gserviceaccount.com' }), /^✗ 403: chưa share cho sa@p\.iam/);
  assert.equal(renderError(new Error('lạ')), '✗ lạ');
  assert.match(renderError(Object.assign(new Error('x'), { code: 'UNCERTAIN_WRITE' })), /^✗ x/);
});
```

- [ ] **Step 3: Chạy, xác nhận đỏ**

Run: `node --test test/table-view.test.mjs test/render.test.mjs`
Expected: FAIL (module chưa có).

- [ ] **Step 4: Tạo `src/table-view.mjs`**

```js
// Lọc cột/dòng và phân trang trên mảng rows (dòng đầu là header). Chạy phía server để
// chỉ phần cần đọc đi vào context của model.

export const DEFAULT_LIMIT = 200;
export const MAX_LIMIT = 2000;

export class ViewError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ViewError';
    this.code = 'BAD_COLUMN';
  }
}

const cell = (row, i) => (row[i] === undefined || row[i] === null ? '' : String(row[i]));

function clamp(n, lo, hi) {
  const v = Number.isFinite(Number(n)) ? Math.trunc(Number(n)) : lo;
  return Math.min(Math.max(v, lo), hi);
}

/** Vị trí cột theo tên: khớp chính xác trước, rồi không phân biệt hoa thường; trùng tên lấy cột đầu. */
function columnIndex(header, name) {
  let i = header.indexOf(name);
  if (i < 0) i = header.findIndex((h) => String(h).toLowerCase() === String(name).toLowerCase());
  if (i < 0) throw new ViewError(`Không có cột "${name}". Header: ${header.join(' | ')}`);
  return i;
}

export function viewTable(rows, { columns = null, where = null, offset = 0, limit = DEFAULT_LIMIT } = {}) {
  const header = (rows[0] ?? []).map((h) => cell([h], 0));
  let body = rows.slice(1);

  if (where && Object.keys(where).length) {
    const conds = Object.entries(where).map(([name, value]) => [columnIndex(header, name), String(value).trim()]);
    body = body.filter((row) => conds.every(([i, value]) => cell(row, i).trim() === value));
  }

  const lim = clamp(limit, 1, MAX_LIMIT);
  const off = clamp(offset, 0, Number.MAX_SAFE_INTEGER);
  const total = body.length;
  let page = body.slice(off, off + lim);
  let outHeader = header;

  if (columns && columns.length) {
    const idx = columns.map((name) => columnIndex(header, name));
    outHeader = idx.map((i) => header[i]);
    page = page.map((row) => idx.map((i) => cell(row, i)));
  }

  return { header: outHeader, rows: page, total, offset: off, limit: lim, next: off + lim < total ? off + lim : null };
}

const clean = (s) => String(s ?? '').replace(/[\t\r\n]+/g, ' ');

export function toTsv(header, rows) {
  const width = header.length;
  const line = (row) => Array.from({ length: Math.max(width, row.length) }, (_, i) => clean(row[i] ?? '')).join('\t');
  return [line(header), ...rows.map(line)].join('\n');
}
```

- [ ] **Step 5: Tạo `src/render.mjs`**

```js
// Định dạng kết quả tool thành văn bản thuần, không bọc JSON. Mỗi dòng đầu bắt đầu bằng `#`
// mô tả ngữ cảnh; lỗi bắt đầu bằng `✗`.

import { MIME } from './formats.mjs';
import { toTsv } from './table-view.mjs';

const CODE_BY_MIME = {
  [MIME.FOLDER]: 'd',
  [MIME.GOOGLE_SHEET]: 's',
  [MIME.GOOGLE_DOC]: 'c',
  [MIME.GOOGLE_SLIDES]: 'p',
  [MIME.XLSX]: 'x',
  [MIME.XLSM]: 'x',
  [MIME.DOCX]: 'w',
  [MIME.PPTX]: 'k',
  [MIME.CSV]: 't',
  [MIME.PLAIN]: 't',
  [MIME.MARKDOWN]: 't',
};
const CODE_BY_EXT = { xlsx: 'x', xlsm: 'x', docx: 'w', pptx: 'k', csv: 't', txt: 't', md: 't', json: 't' };

export function typeCode(mimeType, name = '') {
  if (CODE_BY_MIME[mimeType]) return CODE_BY_MIME[mimeType];
  if (/^text\//.test(mimeType ?? '')) return 't';
  const ext = String(name).toLowerCase().split('.').pop();
  return CODE_BY_EXT[ext] ?? 'f';
}

function sizeLabel(size) {
  const n = Number(size);
  if (!Number.isFinite(n) || n <= 0) return null;
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)}KB`;
  return `${(n / 1024 / 1024).toFixed(1)}MB`;
}

export function renderFolders(folders) {
  const lines = folders.map((f) => `d ${f.name} (${f.access}) ${f.id}`);
  return [`# ${folders.length} folders`, ...lines].join('\n');
}

export function renderLs({ title, access, items, total, next = null }) {
  const head = `# ${title} (${access}) · ${total}${next ? ` · next=${next}` : ''}`;
  const lines = items.map((f) => {
    const parts = [typeCode(f.mimeType, f.name), f.name, f.id];
    if (f.modifiedTime) parts.push(String(f.modifiedTime).slice(0, 10));
    const size = sizeLabel(f.size);
    if (size) parts.push(size);
    return parts.join(' ');
  });
  return [head, ...lines].join('\n');
}

export function renderTable({ file, tab, tabs, view }) {
  const from = view.rows.length ? view.offset + 1 : 0;
  const to = view.offset + view.rows.length;
  const range = view.rows.length ? `rows ${from}-${to}/${view.total}` : `rows 0/${view.total}`;
  const head = `# ${file} › ${tab} · tabs: ${tabs.join(',')} · ${range}${view.next !== null ? ` · next=${view.next}` : ''}`;
  return `${head}\n${toTsv(view.header, view.rows)}`;
}

export function renderDoc({ file, kind, text, total, truncatedAt = null }) {
  const lines = [`# ${file} (${kind}) · ${total} chars`, text];
  if (truncatedAt !== null) lines.push(`# truncated at ${truncatedAt}/${total} chars`);
  return lines.join('\n');
}

export function renderError(err, { email = null } = {}) {
  const msg = String(err?.message ?? err).split('\n')[0];
  const code = Number(err?.code);
  if (err?.name === 'ScopeError') return `✗ ${msg}`;
  if (code === 403 || code === 404) {
    return `✗ ${code}: chưa share cho ${email ?? 'service account'} (Viewer để đọc, Editor để ghi). ${msg}`;
  }
  return `✗ ${msg}`;
}
```

- [ ] **Step 6: Chạy test, xác nhận xanh**

Run: `node --test test/table-view.test.mjs test/render.test.mjs`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/table-view.mjs src/render.mjs test/table-view.test.mjs test/render.test.mjs
git commit -m "feat(render): lọc cột/dòng, phân trang, TSV và định dạng văn bản thuần cho kết quả tool

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: (đã gộp vào Task 5)

Các test Review Focus 1, 4, 5 nằm trong `test/table-view.test.mjs`; Review Focus 2, 3 nằm trong `test/scope.test.mjs`. Không có việc riêng.

---

### Task 7: Kiểm chứng API thật phần ghi (cần người dùng)

ĐÃ CHẠY 2026-10-01 trên folder My Drive của người dùng: tạo folder OK, đổi tên OK, di chuyển OK, tạo Doc/Sheet FAIL 403 `storageQuotaExceeded` (đã đưa vào thiết kế `drive_create`). Còn thiếu `values.append`/`values.batchUpdate`: cần người dùng tạo một Google Sheet trống trong folder đó rồi chạy lại script với `--sheet <url>`. Không chặn task nào.

**Files:**
- Create: `bench/verify-write.mjs` (script tạm, không nằm trong `package.json#files`)
- Modify: `docs/superpowers/specs/2026-10-01-folder-scoped-design.md` (điền bảng mục 4)

- [ ] **Step 1: Xin người dùng link folder thử**

Cần một folder My Drive share **Editor** cho service account; nếu có Shared Drive, thêm một folder ở đó. Không chạy bước 2 trước khi có link.

- [ ] **Step 2: Viết `bench/verify-write.mjs`**

```js
// Thử từng thao tác ghi trên folder thật rồi in bảng. Chạy: node bench/verify-write.mjs <folder-url> [<folder-url-shared-drive>]
// Mọi thứ tạo ra đều nằm trong folder con "gdrive-verify-<timestamp>" để người dùng xoá một lần.
import { createClient } from '../src/client.mjs';
import { createFolder, getFile, uploadFile } from '../src/drive.mjs';
import { appendValues, batchUpdateValues } from '../src/sheets.mjs';
import { parseGoogleUrl } from '../src/url.mjs';
import { MIME } from '../src/formats.mjs';

const client = createClient({ mode: 'readwrite', retries: 2 });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');

async function attempt(label, fn) {
  try {
    const out = await fn();
    console.log(`OK    ${label}${out ? ` → ${out}` : ''}`);
    return out;
  } catch (e) {
    console.log(`FAIL  ${label} → ${e.code ?? ''} ${String(e.message).split('\n')[0]}`);
    return null;
  }
}

for (const url of process.argv.slice(2)) {
  const { id: parentId } = parseGoogleUrl(url);
  const parent = await getFile(client, parentId, { fields: 'id,name,driveId' });
  console.log(`\n== ${parent.name} (${parent.driveId ? 'Shared Drive' : 'My Drive'})`);

  const sub = await attempt('Tạo folder con', async () => (await createFolder(client, { name: `gdrive-verify-${stamp}`, parentId })).id);
  const target = sub ?? parentId;

  const doc = await attempt('Tạo Google Doc từ markdown', async () =>
    (await uploadFile(client, { name: 'verify-doc', folderId: target, content: '# Tiêu đề\n\nxin chào', mimeType: 'text/markdown', convertTo: MIME.GOOGLE_DOC })).id);
  const sheet = await attempt('Tạo Google Sheet từ CSV', async () =>
    (await uploadFile(client, { name: 'verify-sheet', folderId: target, content: 'ID,Trạng thái\nTC1,PASS\n', mimeType: 'text/csv', convertTo: MIME.GOOGLE_SHEET })).id);

  if (sheet) {
    await attempt('values.batchUpdate', () => batchUpdateValues(client, sheet, [{ range: "'Sheet1'!B2", values: [['FAIL']] }]));
    await attempt('values.append', () => appendValues(client, sheet, "'Sheet1'!A1", [['TC2', 'PASS']]));
  }
  if (doc) {
    await attempt('Đổi tên file', () => client.api({ url: `https://www.googleapis.com/drive/v3/files/${doc}?supportsAllDrives=true&fields=id,name`, method: 'PATCH', body: { name: 'verify-doc-renamed' } }));
    if (sub) {
      await attempt('Di chuyển file sang folder cha', () => client.api({ url: `https://www.googleapis.com/drive/v3/files/${doc}?supportsAllDrives=true&addParents=${parentId}&removeParents=${sub}&fields=id,parents`, method: 'PATCH', body: {} }));
    }
  }
  console.log(`Dọn: xoá folder "gdrive-verify-${stamp}" (và file verify-doc-renamed nếu đã di chuyển) trong ${parent.name}.`);
}
```

- [ ] **Step 3: Chạy với link người dùng đưa**

Run: `node bench/verify-write.mjs <url-my-drive> [<url-shared-drive>]`
Expected: bảng OK/FAIL cho từng thao tác. Service account không có quota My Drive nên dự đoán `Tạo Google Doc/Sheet` FAIL với `storageQuotaExceeded` ở My Drive và OK ở Shared Drive; `batchUpdate`, `append`, đổi tên, di chuyển dự đoán OK ở cả hai. Ghi lại kết quả thật, không ghi dự đoán.

- [ ] **Step 4: Điền bảng mục 4 trong spec và commit**

Thay các dấu `?` trong bảng bằng OK/FAIL kèm mã lỗi. Thao tác FAIL ở My Drive thì ghi thêm dòng: "`drive_create` trả lỗi hướng dẫn dùng Shared Drive khi folder đích không có `driveId`".

```bash
git add bench/verify-write.mjs docs/superpowers/specs/2026-10-01-folder-scoped-design.md
git commit -m "docs(spec): kết quả kiểm chứng thao tác ghi trên My Drive và Shared Drive

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 8: `drive.mjs`, `sheets.mjs`, `read-document.mjs` — `updateFile`, `idempotent`, nhận `meta` có sẵn, giới hạn 50 MB

**Files:**
- Modify: `src/drive.mjs`, `src/sheets.mjs`, `src/read-document.mjs`
- Test: `test/drive.test.mjs` (mới), `test/read-document.test.mjs` (mới)

**Interfaces:**
- Consumes: `client.api` chuyển tiếp `idempotent` (Task 2).
- Produces:
  - `updateFile(client, fileId, { name = null, addParents = null, removeParents = null })` → PATCH `files/{id}` với `fields=id,name,parents`.
  - `uploadFile`, `createFolder`, `appendValues` gửi `idempotent: false`.
  - `readTable(client, fileId, { ..., meta = null })`, `readDocument(client, fileId, { ..., meta = null })`: có `meta` thì bỏ qua `inspect`.
  - `MAX_DOWNLOAD_BYTES = 50 * 1024 * 1024`; file lớn hơn ném `UnsupportedFormatError` với `code = 'TOO_LARGE'`.

- [ ] **Step 1: Test đỏ `test/drive.test.mjs`**

```js
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createFolder, updateFile, uploadFile } from '../src/drive.mjs';
import { appendValues, batchUpdateValues } from '../src/sheets.mjs';

function fakeClient(reply = {}) {
  const calls = [];
  return { calls, api: async (opts) => { calls.push(opts); return reply; } };
}

test('updateFile: PATCH đúng tham số addParents/removeParents, body chỉ có name khi đổi tên', async () => {
  const c = fakeClient({ id: 'f', name: 'n', parents: ['p2'] });
  await updateFile(c, 'f', { name: 'n', addParents: 'p2', removeParents: 'p1' });
  const [call] = c.calls;
  assert.equal(call.method, 'PATCH');
  assert.match(call.url, /\/files\/f\?/);
  assert.match(call.url, /addParents=p2/);
  assert.match(call.url, /removeParents=p1/);
  assert.match(call.url, /supportsAllDrives=true/);
  assert.deepEqual(call.body, { name: 'n' });
  assert.notEqual(call.idempotent, false, 'PATCH là idempotent');

  const c2 = fakeClient({});
  await updateFile(c2, 'f', { addParents: 'p2' });
  assert.deepEqual(c2.calls[0].body, {});
});

test('request KHÔNG idempotent được đánh dấu: append, createFolder, uploadFile multipart', async () => {
  const c = fakeClient({ updates: {} });
  await appendValues(c, 's', "'T'!A1", [['x']]);
  await createFolder(c, { name: 'd', parentId: 'p' });
  await uploadFile(c, { name: 'f', folderId: 'p', content: 'abc', mimeType: 'text/plain' });
  for (const call of c.calls) assert.equal(call.idempotent, false, call.url);
});

test('batchUpdateValues giữ idempotent (ghi đè ô là an toàn khi gửi lại)', async () => {
  const c = fakeClient({ totalUpdatedCells: 1, responses: [] });
  await batchUpdateValues(c, 's', [{ range: "'T'!A1", values: [['x']] }]);
  assert.notEqual(c.calls[0].idempotent, false);
});
```

- [ ] **Step 2: Test đỏ `test/read-document.test.mjs`**

Fixture xlsx/docx dựng bằng `makeZip` như các test OOXML hiện có. Client giả trả buffer theo URL.

```js
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { MAX_DOWNLOAD_BYTES, readDocument, readTable } from '../src/read-document.mjs';
import { makeZip } from './helpers/make-zip.mjs';

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

const xlsx = () => makeZip([
  { name: 'xl/workbook.xml', data: `<workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="T" sheetId="1" r:id="rId1"/></sheets></workbook>` },
  { name: 'xl/_rels/workbook.xml.rels', data: `<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>` },
  { name: 'xl/worksheets/sheet1.xml', data: `<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>ID</t></is></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>TC1</t></is></c></row></sheetData></worksheet>` },
]);
const docx = (text) => makeZip([
  { name: 'word/document.xml', data: `<w:document xmlns:w="w"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>` },
]);

function fakeClient({ meta, bytes }) {
  const calls = [];
  return {
    calls,
    async api(opts) {
      calls.push(opts.url);
      if (/alt=media|\/export\?/.test(opts.url)) return bytes;
      return meta;
    },
  };
}

test('readTable với meta có sẵn: KHÔNG gọi files.get, chỉ tải nội dung', async () => {
  const meta = { id: 'x', name: 'a.xlsx', mimeType: XLSX_MIME, size: '1000' };
  const client = fakeClient({ meta, bytes: xlsx() });
  const res = await readTable(client, 'x', { meta });
  assert.deepEqual(res.rows, [['ID'], ['TC1']]);
  assert.equal(client.calls.length, 1);
  assert.match(client.calls[0], /alt=media/);
});

test('readDocument với meta có sẵn: 1 request; max_chars cắt đúng và báo truncated', async () => {
  const meta = { id: 'd', name: 'g.docx', mimeType: DOCX_MIME, size: '10' };
  const client = fakeClient({ meta, bytes: docx('một hai ba bốn') });
  const res = await readDocument(client, 'd', { meta, maxChars: 7 });
  assert.equal(client.calls.length, 1);
  assert.equal(res.content, 'một hai');
  assert.equal(res.truncated, true);
  assert.equal(res.charCount, 14);
});

test('file lớn hơn MAX_DOWNLOAD_BYTES bị từ chối TRƯỚC khi tải', async () => {
  const meta = { id: 'big', name: 'big.xlsx', mimeType: XLSX_MIME, size: String(MAX_DOWNLOAD_BYTES + 1) };
  const client = fakeClient({ meta, bytes: xlsx() });
  await assert.rejects(readTable(client, 'big', { meta }), (e) => e.code === 'TOO_LARGE' && /gdrive get/.test(e.message));
  assert.equal(client.calls.length, 0);
});

test('không truyền meta thì readTable tự inspect như cũ (tương thích thư viện)', async () => {
  const meta = { id: 'x', name: 'a.xlsx', mimeType: XLSX_MIME };
  const client = fakeClient({ meta, bytes: xlsx() });
  const res = await readTable(client, 'x');
  assert.equal(res.rows.length, 2);
  assert.equal(client.calls.length, 2);
});
```

- [ ] **Step 3: Chạy, xác nhận đỏ**

Run: `node --test test/drive.test.mjs test/read-document.test.mjs`
Expected: FAIL (`updateFile`, `MAX_DOWNLOAD_BYTES` chưa có; `idempotent` chưa gắn).

- [ ] **Step 4: Sửa `src/drive.mjs`**

Thêm sau `createFolder`:

```js
/** Đổi tên và/hoặc chuyển folder. PATCH là idempotent nên thử lại thoải mái. */
export async function updateFile(client, fileId, { name = null, addParents = null, removeParents = null } = {}) {
  return client.api({
    url: `${BASE}/files/${encodeURIComponent(fileId)}${buildQuery({
      fields: 'id,name,parents',
      addParents: addParents ?? undefined,
      removeParents: removeParents ?? undefined,
      ...SHARED_DRIVE_PARAMS,
    })}`,
    method: 'PATCH',
    body: name ? { name } : {},
  });
}
```

Trong `createFolder`: thêm `idempotent: false,` vào object truyền cho `client.api`. Trong `uploadFile`: thêm `idempotent: false,` ở cả ba lời gọi `client.api` (multipart, init resumable, PUT). Trong `shareFile`: thêm `idempotent: false,`.

- [ ] **Step 5: Sửa `src/sheets.mjs`**

Trong `appendValues`, thêm `idempotent: false,` vào object truyền cho `client.api`. `batchUpdateValues` giữ nguyên.

- [ ] **Step 6: Sửa `src/read-document.mjs`**

Thêm sau import:

```js
/** Trên ngưỡng này thì không tải vào RAM để đọc — người dùng tải bằng CLI `gdrive get`. */
export const MAX_DOWNLOAD_BYTES = 50 * 1024 * 1024;

function assertDownloadable(meta) {
  if (Number(meta.size ?? 0) > MAX_DOWNLOAD_BYTES) {
    throw new UnsupportedFormatError(
      `"${meta.name}" nặng ${(Number(meta.size) / 1024 / 1024).toFixed(0)} MB, quá ngưỡng ${MAX_DOWNLOAD_BYTES / 1024 / 1024} MB để đọc thẳng. ` +
        'Tải về bằng: gdrive get <url> --out <file>',
      { kind: KIND.OTHER, code: 'TOO_LARGE' },
    );
  }
}
```

Constructor `UnsupportedFormatError` nhận thêm `code`: `constructor(message, { kind, code = 'UNSUPPORTED' } = {})` và gán `this.code = code`.

`readTable`: chữ ký thành `{ sheet = null, gid = null, range = null, maxRows = 500, valueRenderOption = 'FORMATTED_VALUE', meta = null }`; dòng đầu thân hàm thành:

```js
  const picked = meta ? { meta, ...classify(meta.mimeType, meta.name) } : await inspect(client, fileId);
  const { meta: m, kind } = picked;
```

và dùng `m` thay cho `meta` trong phần còn lại. Trước `downloadFile` ở nhánh XLSX gọi `assertDownloadable(m)`.

`readDocument`: tương tự, chữ ký thêm `meta = null`; thay `const { meta, kind, note } = await inspect(client, fileId);` bằng:

```js
  const picked = meta ? { meta, ...classify(meta.mimeType, meta.name) } : await inspect(client, fileId);
  const { meta: m, kind, note } = picked;
```

Trước mỗi `downloadFile` trong hàm gọi `assertDownloadable(m)` (export của Google không có `size`, không cần kiểm). Đổi mọi `meta.` còn lại trong hàm thành `m.`.

- [ ] **Step 7: Chạy toàn bộ test**

Run: `node --test`
Expected: PASS (gồm `test/mcp-server.test.mjs` cũ vẫn chạy vì tool chưa đổi).

- [ ] **Step 8: Commit**

```bash
git add src/drive.mjs src/sheets.mjs src/read-document.mjs test/drive.test.mjs test/read-document.test.mjs
git commit -m "feat(api): updateFile; đánh dấu request không idempotent; read-document nhận meta có sẵn và chặn file quá 50 MB

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 9: `tools.mjs` 5 tool mới, `server/index.mjs` trả văn bản thuần, `instructions.mjs`

**Files:**
- Modify (viết lại): `src/tools.mjs`, `src/instructions.mjs`
- Modify: `server/index.mjs`
- Test: `test/tools.test.mjs` (mới), `test/mcp-server.test.mjs` (cập nhật)

**Interfaces:**
- Consumes: `createScope`, `createMetaStore`, `loadFolders`, `viewTable`, `render*`, `readTable/readDocument({ meta })`, `updateFile`, `uploadFile`, `createFolder`, `appendValues`, `batchUpdateValues`, `getValues`, `pickSheet`, `buildA1`, `listFiles`, `classify`.
- Produces:
  - `buildTools({ getClient, folders, now })` → mảng tool `{ name, description, inputSchema, write, run(args): Promise<string> }`. Tool ghi chỉ có khi `folders.some(f => f.access === 'write')`. `run` trả **chuỗi**; lỗi ném ra để server render.
  - Tên tool: `drive_ls`, `drive_read`, `sheet_write`, `drive_create`, `drive_move`.
  - Server: `tools/call` trả `content: [{ type: 'text', text }]` với `text` là chuỗi tool trả; lỗi → `isError: true`, text là `renderError(err, { email })`.

- [ ] **Step 1: Test đỏ `test/tools.test.mjs`**

Client giả định tuyến theo URL. Fixture xlsx dùng `makeZip` như Task 8.

```js
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildTools } from '../src/tools.mjs';
import { makeZip } from './helpers/make-zip.mjs';

const FOLDER = 'application/vnd.google-apps.folder';
const GSHEET = 'application/vnd.google-apps.spreadsheet';
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

const FILES = {
  rootA: { id: 'rootA', name: 'Test Run', mimeType: FOLDER, parents: [], driveId: 'sd1' },
  rootC: { id: 'rootC', name: 'My Drive folder', mimeType: FOLDER, parents: [] },
  sheet1: { id: 'sheet1', name: 'TC_login', mimeType: GSHEET, parents: ['rootA'], modifiedTime: '2026-09-30T00:00:00Z' },
  book1: { id: 'book1', name: 'report.xlsx', mimeType: XLSX, parents: ['rootA'], size: '2048' },
  rootB: { id: 'rootB', name: 'Bao cao', mimeType: FOLDER, parents: [] },
  sheetB: { id: 'sheetB', name: 'KPI', mimeType: GSHEET, parents: ['rootB'] },
  outside: { id: 'outside', name: 'secret', mimeType: GSHEET, parents: ['zzz'] },
  zzz: { id: 'zzz', name: 'Khac', mimeType: FOLDER, parents: [] },
};
const VALUES = [['ID', 'Trạng thái', 'Ghi chú'], ['TC1', 'PASS', 'ok'], ['TC2', 'FAIL', 'lỗi'], ['TC3', 'FAIL', '']];
const xlsxBuf = () => makeZip([
  { name: 'xl/workbook.xml', data: `<workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Data" sheetId="1" r:id="rId1"/></sheets></workbook>` },
  { name: 'xl/_rels/workbook.xml.rels', data: `<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>` },
  { name: 'xl/worksheets/sheet1.xml', data: `<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>k</t></is></c></row><row r="2"><c r="A2"><v>42</v></c></row></sheetData></worksheet>` },
]);

function fakeClient() {
  const calls = [];
  const client = {
    calls,
    identity: { clientEmail: 'sa@p.iam.gserviceaccount.com' },
    async api(opts) {
      calls.push(opts);
      const u = opts.url;
      let m;
      if ((m = /drive\/v3\/files\/([^/?]+)\?.*alt=media/.exec(u))) return xlsxBuf();
      if ((m = /drive\/v3\/files\/([^/?]+)\?/.exec(u)) && opts.method === 'PATCH') return { id: m[1], ...opts.body };
      if ((m = /drive\/v3\/files\/([^/?]+)\?/.exec(u))) {
        if (!FILES[m[1]]) { const e = new Error('not found'); e.code = 404; throw e; }
        return FILES[m[1]];
      }
      if (/drive\/v3\/files\?/.test(u)) {
        const folder = /'([^']+)' in parents/.exec(decodeURIComponent(u))?.[1];
        return { files: Object.values(FILES).filter((f) => f.parents.includes(folder)), nextPageToken: null };
      }
      if (/upload\/drive\/v3\/files/.test(u)) return { id: 'new1', name: 'new', webViewLink: 'https://drive.google.com/x' };
      if (/drive\/v3\/files$/.test(u.split('?')[0]) && opts.method === 'POST') return { id: 'newFolder', name: opts.body.name };
      if (/spreadsheets\/[^/]+\?fields/.test(u)) return { properties: { title: 'TC_login' }, sheets: [{ properties: { sheetId: 0, title: 'Sheet1', index: 0 } }, { properties: { sheetId: 9, title: 'Data', index: 1 } }] };
      if (/values:batchUpdate/.test(u)) return { totalUpdatedCells: opts.body.data.length, responses: [] };
      if (/:append/.test(u)) return { updates: { updatedRange: "'Sheet1'!A5:C5", updatedCells: opts.body.values.flat().length } };
      if (/\/values\//.test(u)) return { values: VALUES };
      throw new Error(`fake: không biết ${opts.method ?? 'GET'} ${u}`);
    },
  };
  return client;
}

const FOLDERS_RW = [{ name: 'test-run', id: 'rootA', access: 'write' }, { name: 'bao-cao', id: 'rootB', access: 'read' }, { name: 'my-drive', id: 'rootC', access: 'write' }];
const FOLDERS_RO = [{ name: 'bao-cao', id: 'rootB', access: 'read' }];
const tools = (folders, client = fakeClient()) => {
  const list = buildTools({ getClient: () => client, folders });
  return { client, byName: new Map(list.map((t) => [t.name, t])), names: list.map((t) => t.name) };
};

test('tool ghi chỉ xuất hiện khi có folder write; schema gọn', () => {
  assert.deepEqual(tools(FOLDERS_RW).names, ['drive_ls', 'drive_read', 'sheet_write', 'drive_create', 'drive_move']);
  assert.deepEqual(tools(FOLDERS_RO).names, ['drive_ls', 'drive_read']);
  assert.deepEqual(tools([]).names, ['drive_ls', 'drive_read']);
  const bytes = JSON.stringify(buildTools({ getClient: () => null, folders: FOLDERS_RW }).map(({ name, description, inputSchema }) => ({ name, description, inputSchema }))).length;
  assert.ok(Math.ceil(bytes / 3.5) < 700, `schema ≈ ${Math.ceil(bytes / 3.5)} token`);
});

test('drive_ls không path: liệt kê folder được phép; có path: nội dung folder dạng một dòng mỗi mục', async () => {
  const { byName } = tools(FOLDERS_RW);
  assert.equal(await byName.get('drive_ls').run({}), '# 3 folders\nd test-run (write) rootA\nd bao-cao (read) rootB\nd my-drive (write) rootC');
  const out = await byName.get('drive_ls').run({ path: 'test-run' });
  assert.equal(out.split('\n')[0], '# test-run (write) · 2');
  assert.ok(out.includes('s TC_login sheet1 2026-09-30'));
  assert.ok(out.includes('x report.xlsx book1 2KB'));
});

test('drive_ls folder rỗng danh sách → NO_FOLDERS hướng dẫn folder add', async () => {
  const { byName } = tools([]);
  await assert.rejects(byName.get('drive_ls').run({ path: 'x' }), (e) => e.code === 'NO_FOLDERS');
  assert.equal(await byName.get('drive_ls').run({}), '# 0 folders');
});

test('drive_read Google Sheet: TSV, lọc where, chọn cột, header # có tabs và next', async () => {
  const { byName, client } = tools(FOLDERS_RW);
  const out = await byName.get('drive_read').run({ target: 'https://docs.google.com/spreadsheets/d/sheet1/edit', where: { 'Trạng thái': 'FAIL' }, columns: ['ID'], limit: 1 });
  assert.deepEqual(out.split('\n'), ['# TC_login › Sheet1 · tabs: Sheet1,Data · rows 1-1/2 · next=1', 'ID', 'TC2']);
  const valueCalls = client.calls.filter((c) => /\/values\//.test(c.url));
  assert.equal(valueCalls.length, 1, 'lọc phía server, chỉ 1 request lấy giá trị');
});

test('drive_read lần hai cùng file: metadata lấy từ cache, chỉ còn 1 request', async () => {
  const { byName, client } = tools(FOLDERS_RW);
  await byName.get('drive_read').run({ target: 'sheet1' });
  const before = client.calls.length;
  await byName.get('drive_read').run({ target: 'sheet1' });
  assert.equal(client.calls.length - before, 1);
});

test('drive_read xlsx: đọc tab, TSV; ngoài phạm vi → OUT_OF_SCOPE', async () => {
  const { byName } = tools(FOLDERS_RW);
  const out = await byName.get('drive_read').run({ target: 'test-run/report.xlsx' });
  assert.equal(out.split('\n')[0], '# report.xlsx › Data · tabs: Data · rows 1-1/1');
  assert.equal(out.split('\n')[2], '42');
  await assert.rejects(byName.get('drive_read').run({ target: 'outside' }), (e) => e.code === 'OUT_OF_SCOPE');
});

test('drive_read folder → dòng metadata gợi ý drive_ls', async () => {
  const { byName } = tools(FOLDERS_RW);
  assert.match(await byName.get('drive_read').run({ target: 'test-run' }), /^# Test Run · folder · dùng drive_ls/);
});

test('sheet_write: cells → 1 batchUpdate, append → 1 append không idempotent; từ chối folder read', async () => {
  const { byName, client } = tools(FOLDERS_RW);
  const out = await byName.get('sheet_write').run({ target: 'sheet1', cells: { L5: 'PASS', L6: 'FAIL' }, append: [['TC9', 'PASS', '']] });
  assert.equal(out, '✓ Sheet1: 2 cells, +1 rows');
  const batch = client.calls.find((c) => /batchUpdate/.test(c.url));
  assert.deepEqual(batch.body.data.map((d) => d.range), ["'Sheet1'!L5", "'Sheet1'!L6"]);
  const app = client.calls.find((c) => /:append/.test(c.url));
  assert.equal(app.idempotent, false);
  await assert.rejects(byName.get('sheet_write').run({ target: 'sheetB', cells: { A1: 'x' } }), (e) => e.code === 'READ_ONLY');
  await assert.rejects(byName.get('sheet_write').run({ target: 'sheet1' }), /cells hoặc append/);
});

test('drive_create: folder/doc/sheet trong folder write, TSV → CSV; folder read bị từ chối', async () => {
  const { byName, client } = tools(FOLDERS_RW);
  assert.match(await byName.get('drive_create').run({ parent: 'test-run', name: 'Q4', kind: 'folder' }), /^✓ folder Q4 newFolder/);
  assert.match(await byName.get('drive_create').run({ parent: 'test-run', name: 'Ghi chú', kind: 'doc', content: '# x' }), /^✓ doc Ghi chú new1 https:/);
  await byName.get('drive_create').run({ parent: 'test-run', name: 'S', kind: 'sheet', content: 'a\tb\n1\t2' });
  const upload = client.calls.filter((c) => /upload\//.test(c.url)).at(-1);
  assert.match(upload.body.toString('utf8'), /"mimeType":"application\/vnd\.google-apps\.spreadsheet"/);
  assert.match(upload.body.toString('utf8'), /a,b\r?\n1,2/);
  await assert.rejects(byName.get('drive_create').run({ parent: 'bao-cao', name: 'x', kind: 'folder' }), (e) => e.code === 'READ_ONLY');
  // Đo thật 2026-10-01: My Drive tạo folder được, tạo Doc/Sheet bị storageQuotaExceeded → chặn trước khi gọi API.
  assert.match(await byName.get('drive_create').run({ parent: 'my-drive', name: 'Q5', kind: 'folder' }), /^✓ folder Q5/);
  const callsBefore = client.calls.length;
  await assert.rejects(byName.get('drive_create').run({ parent: 'my-drive', name: 'd', kind: 'doc', content: 'x' }), /Shared Drive/);
  assert.equal(client.calls.filter((c) => /upload\//.test(c.url)).length, client.calls.slice(0, callsBefore).filter((c) => /upload\//.test(c.url)).length, 'không gọi upload khi biết trước sẽ thất bại');
  await assert.rejects(byName.get('drive_create').run({ parent: 'test-run', name: 'x', kind: 'pdf' }), /kind/);
});

test('drive_move: đổi tên và chuyển folder; đích phải là folder write', async () => {
  const { byName, client } = tools(FOLDERS_RW);
  const out = await byName.get('drive_move').run({ target: 'sheet1', new_name: 'TC_login_v2', to: 'test-run' });
  assert.match(out, /^✓ TC_login_v2 → test-run/);
  const patch = client.calls.find((c) => c.method === 'PATCH');
  assert.match(patch.url, /addParents=rootA/);
  assert.match(patch.url, /removeParents=rootA/);
  await assert.rejects(byName.get('drive_move').run({ target: 'sheet1', to: 'bao-cao' }), (e) => e.code === 'READ_ONLY');
  await assert.rejects(byName.get('drive_move').run({ target: 'sheet1', to: 'sheetB' }), /không phải folder/);
  await assert.rejects(byName.get('drive_move').run({ target: 'sheet1' }), /new_name hoặc to/);
});

test('không tool nào có tham số đường dẫn trên máy', () => {
  const schemas = JSON.stringify(buildTools({ getClient: () => null, folders: FOLDERS_RW }).map((t) => t.inputSchema));
  assert.doesNotMatch(schemas, /dest_path|local_path/);
});
```

- [ ] **Step 2: Chạy, xác nhận đỏ**

Run: `node --test test/tools.test.mjs`
Expected: FAIL (`buildTools` chưa nhận `folders`, tên tool cũ).

- [ ] **Step 3: Viết lại `src/tools.mjs`**

```js
// Năm tool MCP, trả VĂN BẢN THUẦN (không bọc JSON) để tiết kiệm token. Mọi tool đi qua
// lớp phạm vi (scope.mjs): file ngoài các folder được phép bị từ chối dù service account
// đọc được. Không tool nào đụng tới hệ thống file của máy.

import { createFolder, listFiles, updateFile, uploadFile } from './drive.mjs';
import { classify, KIND, MIME } from './formats.mjs';
import { createMetaStore } from './meta.mjs';
import { readDocument, readTable } from './read-document.mjs';
import { renderDoc, renderFolders, renderLs, renderTable } from './render.mjs';
import { createScope, ScopeError } from './scope.mjs';
import { appendValues, batchUpdateValues, pickSheet } from './sheets.mjs';
import { viewTable } from './table-view.mjs';
import { buildA1 } from './url.mjs';

const target = { type: 'string', description: 'Folder alias (test-run), alias/path, Google URL, or file id.' };

function tsvToCsv(text) {
  if (!text.includes('\t')) return text;
  const q = (c) => (/[",\r\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c);
  return text.split(/\r?\n/).map((line) => line.split('\t').map(q).join(',')).join('\n');
}

/**
 * @param {object} ctx
 * @param {() => object} ctx.getClient   client đã dựng (lazy, cache ở server)
 * @param {Array<{id,name,access}>} ctx.folders  danh sách folder được phép
 */
export function buildTools({ getClient, folders, now = Date.now }) {
  let meta = null;
  let scope = null;
  const ctx = () => {
    const client = getClient();
    meta ??= createMetaStore({ client, now });
    scope ??= createScope({ folders, meta, now });
    return { client, meta, scope };
  };
  const hasWrite = folders.some((f) => f.access === 'write');

  async function readSheetLike({ client, meta }, m, args, gid) {
    const kind = classify(m.mimeType, m.name).kind;
    let tab, tabs, rows;
    if (kind === KIND.GOOGLE_SHEET) {
      const sm = await meta.sheet(m.id);
      tab = pickSheet(sm.sheets, { sheet: args.sheet ?? null, gid });
      tabs = sm.sheets.map((s) => s.title);
      const data = await client.api({
        url: `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(m.id)}/values/${encodeURIComponent(buildA1(tab.title, null))}?valueRenderOption=FORMATTED_VALUE&majorDimension=ROWS`,
      });
      rows = data.values ?? [];
    } else {
      const res = await readTable(client, m.id, { meta: m, sheet: args.sheet ?? null, gid, maxRows: Number.MAX_SAFE_INTEGER });
      tab = res.sheet;
      tabs = res.sheets.map((s) => s.title);
      rows = res.rows;
    }
    const view = viewTable(rows, { columns: args.columns ?? null, where: args.where ?? null, offset: args.offset ?? 0, limit: args.limit ?? 200 });
    return renderTable({ file: m.name, tab: tab.title, tabs, view });
  }

  const all = [
    {
      name: 'drive_ls',
      write: false,
      description: 'List allowed folders (no path) or a folder\'s contents. One line per item: type name id [date] [size].',
      inputSchema: {
        type: 'object',
        properties: {
          path: target,
          query: { type: 'string', description: 'Filter by name contains.' },
          limit: { type: 'integer', description: 'Default 30, max 200.' },
          page: { type: 'string', description: 'next token from a previous call.' },
        },
        additionalProperties: false,
      },
      async run(args) {
        if (!args.path) return renderFolders(folders);
        const { client, scope } = ctx();
        const { fileId, root, meta: m } = await scope.resolve(args.path);
        if (m.mimeType !== MIME.FOLDER) throw new ScopeError('NOT_FOUND', `"${m.name}" không phải folder. Dùng drive_read để đọc.`);
        const max = Math.min(Math.max(Number(args.limit) || 30, 1), 200);
        const { files, nextPageToken } = await listFiles(client, { folderId: fileId, nameContains: args.query ?? null, max, pageToken: args.page ?? null });
        const title = fileId === root.id ? root.name : `${root.name}/…/${m.name}`;
        return renderLs({ title, access: root.access, items: files, total: files.length, next: nextPageToken });
      },
    },

    {
      name: 'drive_read',
      write: false,
      description: 'Read a file. Sheets/xlsx → TSV with header (filter by columns/where, page by offset/limit). Docs/Slides/docx/pptx/text → markdown.',
      inputSchema: {
        type: 'object',
        properties: {
          target,
          sheet: { type: 'string', description: 'Tab name or gid. Default: gid in URL, else first tab.' },
          columns: { type: 'array', items: { type: 'string' }, description: 'Only these header names.' },
          where: { type: 'object', additionalProperties: { type: 'string' }, description: 'Exact match per column, AND.' },
          offset: { type: 'integer' },
          limit: { type: 'integer', description: 'Rows per page, default 200, max 2000.' },
          max_chars: { type: 'integer', description: 'Text files, default 20000.' },
        },
        required: ['target'],
        additionalProperties: false,
      },
      async run(args) {
        const c = ctx();
        const { meta: m, gid } = await c.scope.resolve(args.target);
        const { kind, note } = classify(m.mimeType, m.name);
        if (kind === KIND.GOOGLE_SHEET || kind === KIND.XLSX) return readSheetLike(c, m, args, gid);
        if (kind === KIND.FOLDER) return `# ${m.name} · folder · dùng drive_ls để liệt kê`;
        if ([KIND.GOOGLE_DOC, KIND.GOOGLE_SLIDES, KIND.DOCX, KIND.PPTX, KIND.TEXT].includes(kind)) {
          const maxChars = Math.max(Number(args.max_chars) || 20_000, 1);
          const res = await readDocument(c.client, m.id, { meta: m, maxChars });
          const text = res.warnings.length ? `${res.content}\n# warnings: ${res.warnings.join(' | ')}` : res.content;
          return renderDoc({ file: m.name, kind, text, total: res.charCount, truncatedAt: res.truncated ? maxChars : null });
        }
        return `# ${m.name} · ${m.mimeType}${m.size ? ` · ${m.size} bytes` : ''} · không trích được chữ${note ? `. ${note.split('\n')[0]}` : ''}. Tải về bằng CLI: gdrive get`;
      },
    },

    {
      name: 'sheet_write',
      write: true,
      description: 'Write cells ({"L5":"PASS"}) and/or append rows ([["TC9","PASS"]]) to a Google Sheet in a write folder. One API call each.',
      inputSchema: {
        type: 'object',
        properties: {
          target,
          sheet: { type: 'string', description: 'Tab name or gid.' },
          cells: { type: 'object', additionalProperties: { type: 'string' } },
          append: { type: 'array', items: { type: 'array', items: { type: 'string' } } },
        },
        required: ['target'],
        additionalProperties: false,
      },
      async run(args) {
        const cells = Object.entries(args.cells ?? {});
        const rows = Array.isArray(args.append) ? args.append : [];
        if (!cells.length && !rows.length) throw new Error('Cần cells hoặc append — không có gì để ghi.');
        const { client, meta, scope } = ctx();
        const { fileId, gid, meta: m } = await scope.resolve(args.target);
        await scope.assertWrite(fileId);
        if (m.mimeType !== MIME.GOOGLE_SHEET) throw new Error(`"${m.name}" không phải Google Sheet — chỉ ghi được vào Google Sheet.`);
        const sm = await meta.sheet(fileId);
        const tab = pickSheet(sm.sheets, { sheet: args.sheet ?? null, gid });
        let wrote = 0;
        if (cells.length) {
          const res = await batchUpdateValues(client, fileId, cells.map(([cell, value]) => ({ range: buildA1(tab.title, cell), values: [[String(value)]] })));
          wrote = res.updatedCells;
        }
        if (rows.length) await appendValues(client, fileId, buildA1(tab.title, null), rows.map((r) => r.map((v) => String(v ?? ''))));
        meta.invalidate(fileId);
        return `✓ ${tab.title}: ${wrote} cells, +${rows.length} rows`;
      },
    },

    {
      name: 'drive_create',
      write: true,
      description: 'Create a folder, Google Doc (from markdown) or Google Sheet (from CSV/TSV) inside a write folder.',
      inputSchema: {
        type: 'object',
        properties: {
          parent: target,
          name: { type: 'string' },
          kind: { type: 'string', enum: ['folder', 'doc', 'sheet'] },
          content: { type: 'string', description: 'Markdown for doc, CSV or TSV for sheet.' },
        },
        required: ['parent', 'name', 'kind'],
        additionalProperties: false,
      },
      async run(args) {
        if (!['folder', 'doc', 'sheet'].includes(args.kind)) throw new Error('kind phải là folder, doc hoặc sheet.');
        const { client, meta, scope } = ctx();
        const { fileId: parentId, meta: pm } = await scope.resolve(args.parent);
        await scope.assertWrite(parentId);
        if (pm.mimeType !== MIME.FOLDER) throw new Error(`"${pm.name}" không phải folder.`);
        // Service account không có dung lượng My Drive: tạo Doc/Sheet chỉ được trên Shared Drive
        // (đo thật 2026-10-01: folder thì tạo được, Doc/Sheet bị 403 storageQuotaExceeded).
        if (args.kind !== 'folder' && !pm.driveId) {
          throw new Error(`Không tạo được ${args.kind} trong "${pm.name}": folder nằm trên My Drive, service account không có dung lượng. Dùng folder trên Shared Drive, hoặc người dùng tự tạo file rồi share.`);
        }
        let file;
        if (args.kind === 'folder') {
          file = await createFolder(client, { name: args.name, parentId });
        } else {
          const isDoc = args.kind === 'doc';
          file = await uploadFile(client, {
            name: args.name,
            folderId: parentId,
            content: isDoc ? String(args.content ?? '') : tsvToCsv(String(args.content ?? '')),
            mimeType: isDoc ? 'text/markdown' : 'text/csv',
            convertTo: isDoc ? MIME.GOOGLE_DOC : MIME.GOOGLE_SHEET,
          });
        }
        scope.invalidateAll();
        meta.invalidate(parentId);
        return `✓ ${args.kind} ${args.name} ${file.id}${file.webViewLink ? ` ${file.webViewLink}` : ''}`;
      },
    },

    {
      name: 'drive_move',
      write: true,
      description: 'Rename a file and/or move it to another write folder.',
      inputSchema: {
        type: 'object',
        properties: {
          target,
          new_name: { type: 'string' },
          to: { ...target, description: 'Destination folder (alias, URL or id).' },
        },
        required: ['target'],
        additionalProperties: false,
      },
      async run(args) {
        if (!args.new_name && !args.to) throw new Error('Cần new_name hoặc to.');
        const { client, meta, scope } = ctx();
        const { fileId, meta: m } = await scope.resolve(args.target);
        await scope.assertWrite(fileId);
        let dest = null;
        if (args.to) {
          const r = await scope.resolve(args.to);
          if (r.meta.mimeType !== MIME.FOLDER) throw new Error(`"${r.meta.name}" không phải folder.`);
          await scope.assertWrite(r.fileId);
          dest = r;
        }
        await updateFile(client, fileId, {
          name: args.new_name ?? null,
          addParents: dest?.fileId ?? null,
          removeParents: dest ? (m.parents ?? []).join(',') || null : null,
        });
        scope.invalidateAll();
        meta.invalidate(fileId);
        const where = dest ? ` → ${dest.root.name}${dest.fileId !== dest.root.id ? `/…/${dest.meta.name}` : ''}` : '';
        return `✓ ${args.new_name ?? m.name}${where}`;
      },
    },
  ];

  return hasWrite ? all : all.filter((t) => !t.write);
}
```

- [ ] **Step 4: Chạy `test/tools.test.mjs`, xác nhận xanh**

Run: `node --test test/tools.test.mjs`
Expected: PASS. Nếu test `drive_ls` đếm `total` sai vì `listFiles` giả trả mọi file có parent, sửa fixture chứ không sửa tool.

- [ ] **Step 5: Viết lại `src/instructions.mjs`**

```js
// Hướng dẫn gửi kèm `initialize` (trường MCP `instructions`). Ngắn và trung lập cho mọi
// client; bản đầy đủ nằm ở skills/gdrive/SKILL.md.

export const INSTRUCTIONS = `Google Drive via a service account, limited to allowed folders. Call drive_ls with no args first to see folder aliases and access.

Tools: drive_ls (folders / folder contents), drive_read (any file: sheets as TSV with columns/where/offset/limit, docs as markdown), sheet_write (cells and/or append rows), drive_create (folder/doc/sheet), drive_move (rename/move). Write tools exist only when a folder has write access.

Targets accept an alias (test-run), alias/path/file, a Google URL, or an id. Read big sheets in pages: follow next=<offset> in the first line. Prefer columns/where over reading everything.

Errors start with ✗. "ngoài phạm vi" means the file is outside allowed folders: ask the user to run \`gdrive folder add <url>\`. 403 means the folder is not shared with the service account email shown. Never ask the user to paste key file contents.`;
```

- [ ] **Step 6: Sửa `server/index.mjs`**

Import thêm:

```js
const { loadFolders } = await import('../src/folders.mjs');
const { renderError } = await import('../src/render.mjs');
```

Trong `buildState()`: thay `const mode = cfgWithSource?.config?.mode === 'readwrite' ? 'readwrite' : 'readonly';` bằng:

```js
  let folders = [];
  let folderError = null;
  try {
    folders = loadFolders({ config: cfgWithSource?.config ?? null, env: process.env });
  } catch (err) {
    folderError = err; // config hỏng: server vẫn sống, mọi tool báo lỗi này
  }
  const hasWrite = folders.some((f) => f.access === 'write');
```

Object `next` thêm `folders, hasWrite, folderError`, bỏ `mode`. `getClient` tạo client với `mode: hasWrite ? 'readwrite' : 'readonly', retries: 4`. `buildTools({ getClient, folders })`.

`refreshStateIfChanged`: `const toolsChanged = next.hasWrite !== state.hasWrite;`.

Nhánh `tools/call`:

```js
    case 'tools/call': {
      const tool = snapshot.byName.get(params?.name);
      if (!tool) return fail(id, -32602, `Không có tool "${params?.name}".`);
      try {
        if (snapshot.folderError) throw snapshot.folderError;
        const text = await tool.run(params?.arguments ?? {});
        return ok(id, { content: [{ type: 'text', text }] });
      } catch (err) {
        return ok(id, {
          isError: true,
          content: [{ type: 'text', text: explain(err, snapshot) }],
        });
      }
    }
```

Hàm `explain` viết lại:

```js
function explain(err, snapshot = state) {
  const email = snapshot.client?.identity?.clientEmail ?? null;
  const base = renderError(err, { email });
  if (/không tìm thấy credential|CredentialError/i.test(String(err?.message))) {
    return `${base}\nBảo người dùng chạy: gdrive init --sa-json <đường-dẫn-key.json> (Claude Code: skill /gdrive-setup). Không hỏi nội dung file key.`;
  }
  if (err?.code === 'UNCERTAIN_WRITE') return `${base}\nĐọc lại cuối bảng bằng drive_read trước khi gọi lại sheet_write.`;
  if (/storageQuotaExceeded/i.test(String(err?.message))) return `${base}\nService account không có dung lượng My Drive: folder đích phải nằm trên Shared Drive.`;
  return base;
}
```

- [ ] **Step 7: Cập nhật `test/mcp-server.test.mjs`**

Thay toàn bộ `gdrive_sheet_read` → `drive_read`, `gdrive_sheet_write` → `sheet_write`, bỏ các assert về `gdrive_upload`. Helper `writeConfig(home, cfg)` giữ nguyên; các test gating đổi `{ mode: 'readwrite' }` thành `{ folders: [{ id: 'f1', name: 'run', access: 'write' }] }` và `{ mode: 'readonly' }` thành `{ folders: [{ id: 'f1', name: 'run', access: 'read' }] }`. Test `instructions` đổi regex thành `/drive_read/`. Test `tools/list` readonly: `assert.deepEqual(names, ['drive_ls', 'drive_read'])`.

Thêm 2 test:

```js
test('tools/call trả văn bản thuần, lỗi phạm vi bắt đầu bằng ✗ và là isError', async () => {
  const home = mkdtempSync(join(tmpdir(), 'gdrive-mcp-home-'));
  writeConfig(home, { folders: [] });
  const { msgs } = await talk([INIT, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'drive_read', arguments: { target: 'abcdefghij' } } }], { home });
  const r = msgs.find((m) => m.id === 1).result;
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /^✗ Chưa có folder nào được phép/);
  assert.doesNotMatch(r.content[0].text, /^\{/, 'không bọc JSON');
});

test('config folders hỏng: server vẫn trả lời tools/list, tools/call báo lỗi cấu hình', async () => {
  const home = mkdtempSync(join(tmpdir(), 'gdrive-mcp-home-'));
  writeConfig(home, { folders: [{ id: '1', name: 'Có Dấu', access: 'read' }] });
  const { msgs, code } = await talk([INIT, { jsonrpc: '2.0', id: 1, method: 'tools/list' }, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'drive_ls', arguments: {} } }], { home });
  assert.equal(code, 0);
  assert.ok(msgs.find((m) => m.id === 1).result.tools.length >= 2);
  assert.match(msgs.find((m) => m.id === 2).result.content[0].text, /✗ Tên "Có Dấu" không hợp lệ/);
});
```

- [ ] **Step 8: Chạy toàn bộ test**

Run: `node --test`
Expected: PASS. `test/clients.test.mjs` không tham chiếu tên tool nên không đổi.

- [ ] **Step 9: Commit**

```bash
git add src/tools.mjs src/instructions.mjs server/index.mjs test/tools.test.mjs test/mcp-server.test.mjs
git commit -m "feat(mcp)!: 5 tool mới giới hạn theo folder, kết quả văn bản thuần, bỏ download/upload khỏi MCP

BREAKING CHANGE: gdrive_sheet_read/gdrive_read_document/gdrive_file_info → drive_read,
gdrive_list → drive_ls, gdrive_sheet_write → sheet_write; cần \`gdrive folder add\` sau khi nâng cấp.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 10: CLI `gdrive folder add/list/remove/set`; phạm vi cho `read`, `doc`, `ls`, `write`

**Files:**
- Create: `src/folder-cli.mjs`
- Modify: `bin/cli.mjs` (HELP, `VALUE_FLAGS`, switch, 4 lệnh đọc/ghi)
- Test: `test/folder-cli.test.mjs` (mới)

**Interfaces:**
- Consumes: `loadFolders`, `addFolder`, `removeFolder`, `setAccess`, `slugify` (Task 3); `readConfigWithSource`, `writeConfig` (config); `getFile` (drive); `createScope`, `createMetaStore` (Task 4).
- Produces: `runFolder(flags, { home, env, log, getFile })` → `boolean`. `getFile(id)` inject được để test; mặc định tạo client thật. `scopedTarget(client, input, { home, env })` → `{ id, gid }` dùng trong 4 lệnh CLI.

- [ ] **Step 1: Test đỏ `test/folder-cli.test.mjs`**

```js
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { runFolder } from '../src/folder-cli.mjs';
import { configPath } from '../src/config.mjs';

const FOLDER = 'application/vnd.google-apps.folder';
const DRIVE = {
  '1AbCdEfGhIjK': { id: '1AbCdEfGhIjK', name: 'Báo cáo Q3', mimeType: FOLDER },
  '1XyZxYzXyZxY': { id: '1XyZxYzXyZxY', name: 'Test Run', mimeType: FOLDER },
  '1FiLeFiLeFiL': { id: '1FiLeFiLeFiL', name: 'not-a-folder', mimeType: 'application/vnd.google-apps.spreadsheet' },
};
const getFile = async (id) => {
  if (!DRIVE[id]) { const e = new Error('File not found'); e.code = 404; throw e; }
  return DRIVE[id];
};

async function sandbox(fn) {
  const home = mkdtempSync(join(tmpdir(), 'gdrive-folder-'));
  const env = {};
  const file = configPath(env, home);
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, JSON.stringify({ clientEmail: 'sa@x.com', privateKey: 'k' }));
  const logs = [];
  try {
    return await fn({ home, env, file, logs, log: (l) => logs.push(l), getFile });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}
const cfg = (file) => JSON.parse(readFileSync(file, 'utf8'));

test('folder add: kiểm tra qua Drive, tên mặc định slug từ tên folder, access mặc định read, giữ credential', async () => {
  await sandbox(async (c) => {
    assert.equal(await runFolder({ _: ['folder', 'add', 'https://drive.google.com/drive/folders/1AbCdEfGhIjK'] }, c), true);
    const saved = cfg(c.file);
    assert.deepEqual(saved.folders, [{ id: '1AbCdEfGhIjK', name: 'bao-cao-q3', access: 'read' }]);
    assert.equal(saved.privateKey, 'k');
    assert.match(c.logs.join('\n'), /bao-cao-q3 \(read\)/);
  });
});

test('folder add --name --access write; trùng tên hoặc trùng id → lỗi, config không đổi', async () => {
  await sandbox(async (c) => {
    await runFolder({ _: ['folder', 'add', '1XyZxYzXyZxY'], name: 'test-run', access: 'write' }, c);
    const before = readFileSync(c.file, 'utf8');
    assert.equal(await runFolder({ _: ['folder', 'add', '1AbCdEfGhIjK'], name: 'test-run' }, c), false);
    assert.equal(await runFolder({ _: ['folder', 'add', '1XyZxYzXyZxY'], name: 'khac' }, c), false);
    assert.equal(readFileSync(c.file, 'utf8'), before);
    assert.match(c.logs.join('\n'), /đã có/);
  });
});

test('folder add: không phải folder, hoặc service account không thấy → lỗi nói đúng bệnh', async () => {
  await sandbox(async (c) => {
    assert.equal(await runFolder({ _: ['folder', 'add', '1FiLeFiLeFiL'] }, c), false);
    assert.match(c.logs.join('\n'), /không phải folder/);
    assert.equal(await runFolder({ _: ['folder', 'add', '1NoNoNoNoNoN'] }, c), false);
    assert.match(c.logs.join('\n'), /chưa share cho sa@x\.com/);
    assert.equal(cfg(c.file).folders, undefined);
  });
});

test('folder list / set / remove', async () => {
  await sandbox(async (c) => {
    await runFolder({ _: ['folder', 'add', '1AbCdEfGhIjK'] }, c);
    await runFolder({ _: ['folder', 'add', '1XyZxYzXyZxY'], access: 'write' }, c);
    c.logs.length = 0;
    await runFolder({ _: ['folder', 'list'] }, c);
    assert.match(c.logs.join('\n'), /bao-cao-q3\s+read\s+1AbCdEfGhIjK/);
    assert.match(c.logs.join('\n'), /test-run\s+write\s+1XyZxYzXyZxY/);
    assert.equal(await runFolder({ _: ['folder', 'set', 'bao-cao-q3'], access: 'write' }, c), true);
    assert.equal(cfg(c.file).folders[0].access, 'write');
    assert.equal(await runFolder({ _: ['folder', 'set', 'bao-cao-q3'], access: 'admin' }, c), false);
    assert.equal(await runFolder({ _: ['folder', 'remove', 'test-run'] }, c), true);
    assert.deepEqual(cfg(c.file).folders.map((f) => f.name), ['bao-cao-q3']);
    assert.equal(await runFolder({ _: ['folder', 'remove', 'zzz'] }, c), false);
  });
});

test('folder list khi trống: hướng dẫn add; lệnh con lạ → false kèm cách dùng', async () => {
  await sandbox(async (c) => {
    assert.equal(await runFolder({ _: ['folder', 'list'] }, c), true);
    assert.match(c.logs.join('\n'), /gdrive folder add/);
    assert.equal(await runFolder({ _: ['folder', 'xyz'] }, c), false);
  });
});

test('GDRIVE_FOLDERS đang đặt thì add/set/remove từ chối sửa file (env thắng, sửa file sẽ không có tác dụng)', async () => {
  await sandbox(async (c) => {
    const env = { GDRIVE_FOLDERS: 'e=1AbCdEfGhIjK:read' };
    assert.equal(await runFolder({ _: ['folder', 'add', '1XyZxYzXyZxY'] }, { ...c, env }), false);
    assert.match(c.logs.join('\n'), /GDRIVE_FOLDERS/);
    assert.equal(cfg(c.file).folders, undefined);
  });
});
```

- [ ] **Step 2: Chạy, xác nhận đỏ**

Run: `node --test test/folder-cli.test.mjs`
Expected: FAIL (module chưa có).

- [ ] **Step 3: Tạo `src/folder-cli.mjs`**

```js
// `gdrive folder …`: quản lý danh sách folder được phép trong file config.
//
// `add` gọi Drive một lần để chắc service account thấy folder và đó đúng là folder; sai thì
// báo ngay thay vì để tool báo 404 mơ hồ về sau. Không bao giờ sửa phần credential.

import { homedir } from 'node:os';

import { createClient } from './client.mjs';
import { readConfigWithSource, writeConfig } from './config.mjs';
import { getFile } from './drive.mjs';
import { MIME } from './formats.mjs';
import { ACCESS_LEVELS, addFolder, loadFolders, removeFolder, setAccess, slugify } from './folders.mjs';
import { parseGoogleUrl } from './url.mjs';

const USAGE = `Cách dùng:
  gdrive folder add <url|id> [--name <tên>] [--access read|write]   (mặc định read)
  gdrive folder list
  gdrive folder set <tên> --access read|write
  gdrive folder remove <tên>`;

function defaultGetFile(home, env) {
  const client = createClient({ mode: 'readonly', retries: 2, env, ...(home ? { home } : {}) });
  return (id) => getFile(client, id, { fields: 'id,name,mimeType,driveId' });
}

export async function runFolder(flags = {}, { home = homedir(), env = process.env, log = console.log, getFile: fetchFile = null } = {}) {
  const sub = flags._[1];
  const arg = flags._[2];
  const found = readConfigWithSource(home, env);
  const config = found?.config ?? {};
  const folders = loadFolders({ config, env });

  if (sub === 'list') {
    if (!folders.length) {
      log('Chưa có folder nào được phép. Thêm bằng: gdrive folder add <url-folder> [--access write]');
      return true;
    }
    const w = Math.max(...folders.map((f) => f.name.length));
    for (const f of folders) log(`${f.name.padEnd(w)}  ${f.access.padEnd(5)}  ${f.id}`);
    if (env.GDRIVE_FOLDERS) log('\n(đang lấy từ biến GDRIVE_FOLDERS, không phải file config)');
    return true;
  }

  if (!['add', 'set', 'remove'].includes(sub)) {
    log(USAGE);
    return false;
  }
  if (env.GDRIVE_FOLDERS) {
    log('❌ Biến GDRIVE_FOLDERS đang được đặt nên danh sách lấy từ env; sửa file config sẽ không có tác dụng. Bỏ biến đó rồi chạy lại.');
    return false;
  }
  if (!found) {
    log('❌ Chưa có cấu hình. Chạy trước: gdrive init --sa-json <đường-dẫn-key.json>');
    return false;
  }

  let next;
  try {
    if (sub === 'add') {
      if (!arg) throw new Error(`Thiếu URL hoặc id folder.\n${USAGE}`);
      const access = flags.access ?? 'read';
      if (!ACCESS_LEVELS.includes(access)) throw new Error('--access phải là read hoặc write.');
      const { id } = parseGoogleUrl(String(arg));
      let meta;
      try {
        meta = await (fetchFile ?? defaultGetFile(home, env))(id);
      } catch (err) {
        if (Number(err?.code) === 404 || Number(err?.code) === 403) {
          throw new Error(`Service account không thấy folder ${id} — chưa share cho ${config.clientEmail ?? 'service account'} (Viewer để đọc, Editor để ghi).`);
        }
        throw err;
      }
      if (meta.mimeType !== MIME.FOLDER) throw new Error(`"${meta.name}" không phải folder (${meta.mimeType}).`);
      const name = flags.name ? String(flags.name) : slugify(meta.name);
      next = addFolder(folders, { id: meta.id, name, access });
      log(`✅ Đã thêm ${name} (${access}) ← "${meta.name}"${meta.driveId ? '' : '\n   Folder nằm trên My Drive: tạo file mới trong đó sẽ thất bại vì service account không có dung lượng; ghi ô Sheet vẫn được.'}`);
    } else if (sub === 'set') {
      if (!arg || !flags.access) throw new Error(`Cần <tên> và --access.\n${USAGE}`);
      if (!ACCESS_LEVELS.includes(flags.access)) throw new Error('--access phải là read hoặc write.');
      next = setAccess(folders, String(arg), flags.access);
      log(`✅ ${arg} → ${flags.access}`);
    } else {
      if (!arg) throw new Error(`Thiếu <tên>.\n${USAGE}`);
      next = removeFolder(folders, String(arg));
      log(`✅ Đã bỏ ${arg} khỏi danh sách (file trên Drive không bị đụng tới).`);
    }
  } catch (err) {
    log(`❌ ${err.message}`);
    return false;
  }

  const { mode, ...rest } = config; // khoá mode cũ không còn ý nghĩa khi có folders
  writeConfig({ ...rest, folders: next }, home, env);
  log('MCP server nhận thay đổi ở request kế tiếp; client không refresh tool list thì mở session mới.');
  return true;
}
```

- [ ] **Step 4: Sửa `bin/cli.mjs`**

Import: `import { runFolder } from '../src/folder-cli.mjs';` và `import { loadFolders } from '../src/folders.mjs';`, `import { createMetaStore } from '../src/meta.mjs';`, `import { createScope } from '../src/scope.mjs';`, `import { readConfig } from '../src/config.mjs';` (đã có).

`VALUE_FLAGS` thêm `'access'` (đã có `'name'`).

`HELP`: thêm sau khối `gdrive status`:

```
  gdrive folder add <url|id> [--name <tên>] [--access read|write]
  gdrive folder list | set <tên> --access … | remove <tên>
        Danh sách folder được phép — tool MCP chỉ đọc/ghi trong các folder này.
```

Thêm helper sau `clientFor`:

```js
/**
 * Khi đã có danh sách folder, CLI cũng tuân phạm vi như MCP: file ngoài folder được phép
 * bị từ chối. Chưa có danh sách thì CLI đọc mọi thứ service account thấy (dùng tay, không
 * phải model gọi).
 */
async function scopedTarget(client, input) {
  const folders = loadFolders({ config: readConfig(), env: process.env });
  if (!folders.length) return parseGoogleUrl(input);
  const meta = createMetaStore({ client });
  const scope = createScope({ folders, meta });
  const { fileId, gid } = await scope.resolve(input);
  return { id: fileId, gid };
}
```

Trong `cmdRead`, `cmdDoc`, `cmdWrite`: thay `const { id, gid } = parseGoogleUrl(requireArg(flags, 1, '<url>'));` bằng `const client = clientFor(flags[, { needWrite: true }]); const { id, gid } = await scopedTarget(client, requireArg(flags, 1, '<url>'));` (bỏ dòng `const client = clientFor(...)` cũ phía dưới). Trong `cmdLs`: `const folderId = target ? (await scopedTarget(client, target)).id : null;` sau khi tạo client.

Switch: thêm `case 'folder': return runFolder(flags);`.

- [ ] **Step 5: Chạy toàn bộ test và thử tay**

Run: `node --test`
Expected: PASS.

Run: `GDRIVE_CONFIG_DIR=$(mktemp -d) node bin/cli.mjs folder list`
Expected: in hướng dẫn `gdrive folder add`, exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/folder-cli.mjs bin/cli.mjs test/folder-cli.test.mjs
git commit -m "feat(cli): gdrive folder add/list/set/remove; read/doc/ls/write tuân phạm vi folder

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 11: OOXML — pptx theo `sldIdLst`, docx số âm, xlsx `r:id`, zip `maxOutputLength`

Độc lập với các task khác.

**Files:**
- Create: `src/ooxml-rels.mjs`
- Modify: `src/ooxml-pptx.mjs`, `src/ooxml-docx.mjs:108`, `src/ooxml-xlsx.mjs:125-140`, `src/zip.mjs:171-174`
- Test: `test/ooxml-pptx.test.mjs`, `test/ooxml-docx.test.mjs`, `test/ooxml-xlsx.test.mjs`, `test/zip.test.mjs`

**Interfaces:**
- Produces: `parseRels(xml): Map<string, { target: string, type: string }>`; `resolveTarget(baseDir, target): string` (xử lý `../`, đường dẫn tuyệt đối `/ppt/…`).

- [ ] **Step 1: Test đỏ pptx (thêm vào `test/ooxml-pptx.test.mjs`)**

```js
const presentation = (rids) => `<p:presentation xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldIdLst>${rids.map((r, i) => `<p:sldId id="${256 + i}" r:id="${r}"/>`).join('')}</p:sldIdLst></p:presentation>`;
const rels = (pairs) => `<Relationships>${pairs.map(([id, target, type = 'slide']) => `<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${type}" Target="${target}"/>`).join('')}</Relationships>`;

test('thứ tự slide theo sldIdLst + rels, KHÔNG theo số trong tên file', () => {
  const buf = makeZip([
    { name: 'ppt/presentation.xml', data: presentation(['rId3', 'rId2']) },
    { name: 'ppt/_rels/presentation.xml.rels', data: rels([['rId2', 'slides/slide1.xml'], ['rId3', '/ppt/slides/slide2.xml']]) },
    { name: 'ppt/slides/slide1.xml', data: slide('Một') },
    { name: 'ppt/slides/slide2.xml', data: slide('Hai') },
  ]);
  const { slides, warnings } = readPptx(buf);
  assert.deepEqual(slides.map((s) => s.title), ['Hai', 'Một']);
  assert.deepEqual(slides.map((s) => s.number), [1, 2]);
  assert.equal(warnings.some((w) => /thứ tự/.test(w)), false);
});

test('thiếu presentation.xml → rơi về thứ tự theo tên file kèm warning', () => {
  const { slides, warnings } = readPptx(pptx());
  assert.deepEqual(slides.map((s) => s.title), ['Slide một', 'Slide hai', 'Slide mười']);
  assert.ok(warnings.some((w) => /thứ tự slide/.test(w)));
});

test('notes ghép qua slides/_rels/slideN.xml.rels, không theo số', () => {
  const buf = makeZip([
    { name: 'ppt/slides/slide1.xml', data: slide('A') },
    { name: 'ppt/slides/_rels/slide1.xml.rels', data: rels([['rId9', '../notesSlides/notesSlide7.xml', 'notesSlide']]) },
    { name: 'ppt/notesSlides/notesSlide7.xml', data: notes('ghi chú của A') },
    { name: 'ppt/notesSlides/notesSlide1.xml', data: notes('KHÔNG phải của A') },
  ]);
  const { slides } = readPptx(buf, { includeNotes: true });
  assert.equal(slides[0].notes, 'ghi chú của A');
});
```

- [ ] **Step 2: Test đỏ docx, xlsx, zip**

Thêm vào `test/ooxml-docx.test.mjs` (dùng helper dựng docx sẵn có trong file; nếu helper tên khác `docx(...)`, dùng tên đó):

```js
test('format text: hàng bảng có số âm ở cột đầu KHÔNG bị xoá, chỉ dòng phân cách bị bỏ', () => {
  const xml = `<w:document xmlns:w="w"><w:body><w:tbl><w:tr><w:tc><w:p><w:r><w:t>Số</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Ghi chú</w:t></w:r></w:p></w:tc></w:tr><w:tr><w:tc><w:p><w:r><w:t>-5</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>lỗ</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:body></w:document>`;
  const { content } = readDocx(makeZip([{ name: 'word/document.xml', data: xml }]), { format: 'text' });
  assert.match(content, /-5\s+lỗ/);
  assert.doesNotMatch(content, /---/);
});
```

Thêm vào `test/ooxml-xlsx.test.mjs`:

```js
test('r:id với tiền tố namespace KHÁC "r" vẫn map đúng part qua rels', () => {
  const buf = makeZip([
    { name: 'xl/workbook.xml', data: `<workbook xmlns:ns1="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Only" sheetId="1" ns1:id="rId7"/></sheets></workbook>` },
    { name: 'xl/_rels/workbook.xml.rels', data: `<Relationships><Relationship Id="rId7" Target="worksheets/sheetX.xml"/></Relationships>` },
    { name: 'xl/worksheets/sheetX.xml', data: `<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>đúng</t></is></c></row></sheetData></worksheet>` },
  ]);
  const wb = openXlsx(buf);
  assert.deepEqual(wb.readSheet({}).rows, [['đúng']]);
});
```

Thêm vào `test/zip.test.mjs`:

```js
import { inflateRawSync } from 'node:zlib';

test('entry giải nén vượt maxOutputLength → ZipError, không RangeError trần', () => {
  const big = Buffer.alloc(3 * 1024 * 1024, 0x61); // 3 MB chữ a, nén còn vài KB
  const buf = makeZip([{ name: 'bomb.txt', data: big }]);
  const zip = openZip(buf, { maxInflateBytes: 1024 * 1024 });
  assert.throws(() => zip.readText('bomb.txt'), (e) => e.name === 'ZipError' && /quá lớn/.test(e.message));
  assert.equal(openZip(buf).readText('bomb.txt').length, big.length, 'mặc định 256 MB vẫn đọc được');
});
```

- [ ] **Step 3: Chạy, xác nhận đỏ**

Run: `node --test test/ooxml-pptx.test.mjs test/ooxml-docx.test.mjs test/ooxml-xlsx.test.mjs test/zip.test.mjs`
Expected: FAIL ở các test mới; test cũ vẫn xanh.

- [ ] **Step 4: Tạo `src/ooxml-rels.mjs`**

```js
// Đọc file .rels của OOXML: Id → {target, type}. Dùng chung cho pptx (thứ tự slide, notes)
// và có thể cho xlsx về sau.

import { forEachElement } from './xml.mjs';

export function parseRels(xml) {
  const map = new Map();
  forEachElement(xml ?? '', 'Relationship', ({ attrs }) => {
    if (attrs.Id) map.set(attrs.Id, { target: attrs.Target ?? '', type: attrs.Type ?? '' });
  });
  return map;
}

/** `../notesSlides/x.xml` từ `ppt/slides/` → `ppt/notesSlides/x.xml`; `/ppt/a.xml` → `ppt/a.xml`. */
export function resolveTarget(baseDir, target) {
  if (target.startsWith('/')) return target.slice(1);
  const parts = baseDir.split('/').filter(Boolean);
  for (const seg of target.split('/')) {
    if (seg === '..') parts.pop();
    else if (seg !== '.' && seg !== '') parts.push(seg);
  }
  return parts.join('/');
}
```

- [ ] **Step 5: Sửa `src/ooxml-pptx.mjs`**

Import `parseRels, resolveTarget` từ `./ooxml-rels.mjs` và `forEachElement` từ `./xml.mjs`. Thay phần thân `readPptx` từ `const slideParts = …` tới trước `const warnings = [];` bằng:

```js
  const warnings = [];
  let slideParts = [];
  const presXml = zip.readText('ppt/presentation.xml');
  const presRels = parseRels(zip.readText('ppt/_rels/presentation.xml.rels'));
  if (presXml && presRels.size) {
    const order = [];
    forEachElement(presXml, 'sldIdLst', ({ inner }) => {
      forEachElement(inner, 'sldId', ({ attrs }) => {
        const rid = Object.entries(attrs).find(([k]) => /(^|:)id$/.test(k) && k !== 'id')?.[1];
        const rel = rid && presRels.get(rid);
        if (rel) order.push(resolveTarget('ppt', rel.target));
      });
    });
    slideParts = order.filter((name) => zip.has(name)).map((name, i) => ({ name, n: i + 1 }));
  }
  if (!slideParts.length) {
    slideParts = numberedParts(names, SLIDE_RE);
    if (slideParts.length && presXml) warnings.push('Không đọc được thứ tự slide từ presentation.xml — xếp theo tên file, có thể lệch.');
    if (slideParts.length && !presXml) warnings.push('Thiếu presentation.xml — thứ tự slide xếp theo tên file, có thể lệch.');
  }
  if (!slideParts.length) {
    throw new ZipError('Không tìm thấy ppt/slides/slideN.xml — file không phải .pptx hợp lệ.');
  }

  const notesFor = (slideName) => {
    if (!includeNotes) return null;
    const relsName = slideName.replace(/^(.*\/)([^/]+)$/, '$1_rels/$2.rels');
    const rels = parseRels(zip.readText(relsName));
    const rel = [...rels.values()].find((r) => /\/notesSlide$/.test(r.type));
    let part = rel ? resolveTarget(slideName.replace(/\/[^/]+$/, ''), rel.target) : null;
    if (!part) {
      const n = SLIDE_RE.exec(slideName)?.[1];
      part = n ? `ppt/notesSlides/notesSlide${n}.xml` : null;
    }
    const text = part ? paragraphsOf(zip.readText(part) ?? '').join('\n') : '';
    return text || null;
  };
```

Bỏ khối `const notesByNumber = …` cũ (và hằng `NOTES_RE` nếu không còn dùng). Trong `slides = slideParts.map(({ name, n }, i) => …)` thay `notes: notesByNumber.get(n) ?? null` bằng `notes: notesFor(name)` và bỏ dòng `const warnings = [];` trùng phía dưới.

- [ ] **Step 6: Sửa `src/ooxml-docx.mjs:108`**

Thay:

```js
      if (md) blocks.push(format === 'markdown' ? md : md.replace(/\|/g, ' ').replace(/^\s*-+.*$/gm, ''));
```

bằng:

```js
      // Ở dạng text: bỏ ĐÚNG dòng phân cách `|---|---|` của bảng markdown rồi mới bỏ dấu |.
      // Regex cũ xoá mọi dòng bắt đầu bằng "-", kể cả hàng có số âm ở cột đầu.
      if (md) blocks.push(format === 'markdown' ? md : md.replace(/^\|?(?:\s*:?-+:?\s*\|)+\s*$/gm, '').replace(/\|/g, ' ').replace(/\n{2,}/g, '\n'));
```

- [ ] **Step 7: Sửa `src/ooxml-xlsx.mjs:125-140`**

Trước `forEachElement(xml, 'sheets', …)` thêm:

```js
  // Tiền tố của namespace relationships không cố định ("r" là thói quen, không phải luật).
  const REL_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
  const relPrefixes = new Set(['r']);
  const collectPrefixes = (attrs) => {
    for (const [k, v] of Object.entries(attrs)) if (k.startsWith('xmlns:') && v === REL_NS) relPrefixes.add(k.slice(6));
  };
  forEachElement(xml, 'workbook', ({ attrs }) => collectPrefixes(attrs));
  const relId = (attrs) => {
    collectPrefixes(attrs);
    for (const p of relPrefixes) if (attrs[`${p}:id`]) return attrs[`${p}:id`];
    return Object.entries(attrs).find(([k]) => /^[\w.-]+:id$/.test(k))?.[1] ?? attrs.id ?? '';
  };
```

và đổi `rid: attrs['r:id'] ?? attrs.id ?? '',` thành `rid: relId(attrs),`. Lưu ý `forEachElement(xml, 'workbook', …)` chỉ bắt được phần tử gốc nếu `xml` bắt đầu bằng thẻ `<workbook` hoặc `<x:workbook`; nếu helper không khớp thẻ gốc, dùng regex `/<(?:[\w.-]+:)?workbook\b([^>]*)>/` lấy nhóm 1 rồi `parseAttrs`.

- [ ] **Step 8: Sửa `src/zip.mjs`**

`openZip(buffer, { maxInflateBytes = 256 * 1024 * 1024 } = {})`; truyền xuống hàm đọc entry. Thay `return inflateRawSync(data);` bằng:

```js
    try {
      return inflateRawSync(data, { maxOutputLength: maxInflateBytes });
    } catch (err) {
      if (err?.code === 'ERR_BUFFER_TOO_LARGE' || /maxOutputLength|Cannot create a Buffer larger/i.test(String(err?.message))) {
        throw new ZipError(`"${entry.name}" giải nén quá lớn (trên ${Math.round(maxInflateBytes / 1024 / 1024)} MB) — từ chối để tránh zip bomb.`);
      }
      throw new ZipError(`"${entry.name}" giải nén lỗi: ${err?.message ?? err}`);
    }
```

- [ ] **Step 9: Chạy toàn bộ test**

Run: `node --test`
Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add src/ooxml-rels.mjs src/ooxml-pptx.mjs src/ooxml-docx.mjs src/ooxml-xlsx.mjs src/zip.mjs test/ooxml-pptx.test.mjs test/ooxml-docx.test.mjs test/ooxml-xlsx.test.mjs test/zip.test.mjs
git commit -m "fix(ooxml): thứ tự slide theo sldIdLst, notes qua rels, docx text giữ số âm, xlsx r:id mọi tiền tố, chặn zip bomb

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 12: `bench/tokens.mjs` + cổng CI; dọn trùng lặp `nodeOk`

**Files:**
- Create: `bench/tokens.mjs`, `test/fixtures/sample-rows.json`, `src/node-version.mjs`
- Modify: `.github/workflows/ci.yml`, `package.json` (scripts), `server/index.mjs`, `src/status.mjs`
- Test: `test/bench.test.mjs` (mới)

**Interfaces:**
- Produces: `estimateTokens(text): number` = `Math.ceil(Buffer.byteLength(text) / 3.5)`; `measure(): { schemaTokens, schemaBytes, samples: Array<{ name, bytes, tokens }> }`; script exit 1 khi `schemaTokens > 700`. `nodeOk(version): boolean`, `MIN_NODE` export từ `src/node-version.mjs`.

- [ ] **Step 1: Test đỏ `test/bench.test.mjs`**

```js
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { estimateTokens, measure, SCHEMA_TOKEN_LIMIT } from '../bench/tokens.mjs';
import { MIN_NODE, nodeOk } from '../src/node-version.mjs';

test('estimateTokens theo byte/3.5', () => {
  assert.equal(estimateTokens('a'.repeat(35)), 10);
  assert.equal(estimateTokens(''), 0);
});

test('schema 5 tool dưới ngưỡng; mẫu đọc sheet 200 dòng được đo', () => {
  const m = measure();
  assert.ok(m.schemaTokens < SCHEMA_TOKEN_LIMIT, `schema ≈ ${m.schemaTokens} token (giới hạn ${SCHEMA_TOKEN_LIMIT})`);
  const sheet = m.samples.find((s) => s.name === 'drive_read sheet 200 rows');
  assert.ok(sheet.tokens > 0);
  assert.ok(m.samples.find((s) => s.name === 'drive_ls 30 items').tokens > 0);
});

test('nodeOk dùng chung: đúng biên 18.17.0', () => {
  assert.equal(MIN_NODE.major, 18);
  assert.equal(nodeOk('v18.17.0'), true);
  assert.equal(nodeOk('v18.16.9'), false);
  assert.equal(nodeOk('v22.0.0'), true);
});
```

- [ ] **Step 2: Chạy, xác nhận đỏ**

Run: `node --test test/bench.test.mjs`
Expected: FAIL (module chưa có).

- [ ] **Step 3: Tạo `src/node-version.mjs` và dùng ở hai nơi**

```js
// Một chỗ duy nhất định nghĩa Node tối thiểu — server và status cùng đọc.
export const MIN_NODE = { major: 18, minor: 17, patch: 0 };

export function parseNodeVersion(version) {
  const [, major = '0', minor = '0', patch = '0'] = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(version)) ?? [];
  return { major: Number(major), minor: Number(minor), patch: Number(patch) };
}

export function nodeOk(version) {
  const got = parseNodeVersion(version);
  if (got.major !== MIN_NODE.major) return got.major > MIN_NODE.major;
  if (got.minor !== MIN_NODE.minor) return got.minor > MIN_NODE.minor;
  return got.patch >= MIN_NODE.patch;
}
```

Trong `server/index.mjs`: xoá `MIN_NODE`, `parseNodeVersion`, `nodeOk` cục bộ; thay bằng `const { nodeOk } = await import('../src/node-version.mjs');` **sau** dòng `console.log = console.error` nhưng import này đứng trước kiểm tra version, nên phải là import tĩnh ở đầu file: `import { nodeOk } from '../src/node-version.mjs';` (file không dùng cú pháp mới hơn Node 18, an toàn). Trong `src/status.mjs`: xoá bản sao cục bộ, `import { nodeOk } from './node-version.mjs';`.

- [ ] **Step 4: Tạo `test/fixtures/sample-rows.json`**

Sinh một lần bằng script rồi commit (dữ liệu giả, không có thông tin thật):

```bash
node -e "
const rows=[['ID','Tên test case','Trạng thái','Người chạy','Ghi chú','Ngày']];
for(let i=1;i<=400;i++)rows.push(['TC'+String(i).padStart(3,'0'),'Kiểm tra màn hình '+(i%7)+' bước '+(i%5),['PASS','FAIL','SKIP'][i%3],'qa'+(i%4),i%6?'':'Lỗi hiển thị nút khi resize cửa sổ','2026-09-'+String(1+i%28).padStart(2,'0')]);
require('fs').mkdirSync('test/fixtures',{recursive:true});
require('fs').writeFileSync('test/fixtures/sample-rows.json',JSON.stringify(rows));"
```

- [ ] **Step 5: Tạo `bench/tokens.mjs`**

```js
#!/usr/bin/env node
// Đo kích thước schema tool và kết quả mẫu. Không có tokenizer (zero dependency) nên ước
// lượng ceil(bytes/3.5); con số thật trong README đo bằng tiktoken và ghi rõ ngày đo.
// CI chạy `node bench/tokens.mjs` và đỏ khi schema vượt ngưỡng.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { INSTRUCTIONS } from '../src/instructions.mjs';
import { renderLs, renderTable } from '../src/render.mjs';
import { viewTable } from '../src/table-view.mjs';
import { buildTools } from '../src/tools.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
export const SCHEMA_TOKEN_LIMIT = 700;

export const estimateTokens = (text) => Math.ceil(Buffer.byteLength(String(text), 'utf8') / 3.5);

export function measure() {
  const folders = [{ id: 'a', name: 'test-run', access: 'write' }];
  const schema = JSON.stringify(
    buildTools({ getClient: () => null, folders }).map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
  );
  const rows = JSON.parse(readFileSync(join(ROOT, 'test', 'fixtures', 'sample-rows.json'), 'utf8'));
  const sheet200 = renderTable({ file: 'TC_login', tab: 'Sheet1', tabs: ['Sheet1', 'Data'], view: viewTable(rows, { limit: 200 }) });
  const sheetFail = renderTable({ file: 'TC_login', tab: 'Sheet1', tabs: ['Sheet1'], view: viewTable(rows, { where: { 'Trạng thái': 'FAIL' }, columns: ['ID', 'Ghi chú'] }) });
  const ls = renderLs({
    title: 'test-run', access: 'write', total: 30, next: null,
    items: Array.from({ length: 30 }, (_, i) => ({ id: `1AbCdEfGhIjKlMnOpQrStUvWxYz${i}`, name: `report-${i}.xlsx`, mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', modifiedTime: '2026-09-30T00:00:00Z', size: '40960' })),
  });
  const sample = (name, text) => ({ name, bytes: Buffer.byteLength(text), tokens: estimateTokens(text) });
  return {
    schemaBytes: Buffer.byteLength(schema),
    schemaTokens: estimateTokens(schema),
    instructionsTokens: estimateTokens(INSTRUCTIONS),
    samples: [
      sample('drive_read sheet 200 rows', sheet200),
      sample('drive_read where FAIL, 2 columns', sheetFail),
      sample('drive_ls 30 items', ls),
    ],
  };
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const m = measure();
  console.log(`schema          ${String(m.schemaBytes).padStart(7)} B  ≈ ${String(m.schemaTokens).padStart(5)} tok  (giới hạn ${SCHEMA_TOKEN_LIMIT})`);
  console.log(`instructions    ${''.padStart(7)}     ≈ ${String(m.instructionsTokens).padStart(5)} tok`);
  for (const s of m.samples) console.log(`${s.name.padEnd(36)} ${String(s.bytes).padStart(7)} B  ≈ ${String(s.tokens).padStart(5)} tok`);
  if (m.schemaTokens > SCHEMA_TOKEN_LIMIT) {
    console.error(`\n✗ schema vượt ${SCHEMA_TOKEN_LIMIT} token ước lượng — rút gọn mô tả tool.`);
    process.exit(1);
  }
}
```

Trên Windows, `new URL(\`file://${process.argv[1]}\`)` sai với ổ đĩa; dùng `pathToFileURL(process.argv[1]).href` từ `node:url` thay cho đoạn đó.

- [ ] **Step 6: CI và scripts**

`.github/workflows/ci.yml` thêm sau `- run: node --test`:

```yaml
      - run: node bench/tokens.mjs
```

`package.json` scripts thêm `"bench": "node bench/tokens.mjs"`. Không thêm `bench/` vào `files`.

- [ ] **Step 7: Chạy test và bench**

Run: `node --test && node bench/tokens.mjs`
Expected: PASS; bench in bảng, schema dưới 700.

- [ ] **Step 8: Commit**

```bash
git add bench/tokens.mjs test/fixtures/sample-rows.json test/bench.test.mjs src/node-version.mjs server/index.mjs src/status.mjs .github/workflows/ci.yml package.json
git commit -m "chore(bench): đo token schema và kết quả mẫu, CI đỏ khi schema vượt 700; gom nodeOk về một chỗ

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 13: Skill, README, CHANGELOG, bump 0.4.0

**Files:**
- Modify: `skills/gdrive/SKILL.md`, `skills/gdrive-setup/SKILL.md`, `README.md`, `CHANGELOG.md`, `package.json`, `.claude-plugin/plugin.json`, `server/index.mjs` (`SERVER_INFO`)
- Test: `test/version.test.mjs` (mới)

- [ ] **Step 1: Test đỏ `test/version.test.mjs` — version khớp 5 chỗ**

```js
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

test('version giống nhau ở package.json, plugin.json, SERVER_INFO và hai SKILL.md', () => {
  const pkg = JSON.parse(read('package.json')).version;
  assert.equal(JSON.parse(read('.claude-plugin/plugin.json')).version, pkg);
  assert.match(read('server/index.mjs'), new RegExp(`version: '${pkg.replace(/\\./g, '\\\\.')}'`));
  for (const f of ['skills/gdrive/SKILL.md', 'skills/gdrive-setup/SKILL.md']) {
    assert.match(read(f), new RegExp(`^version: ${pkg.replace(/\\./g, '\\\\.')}$`, 'm'), f);
  }
  assert.match(read('CHANGELOG.md'), new RegExp(`^## \\[${pkg.replace(/\\./g, '\\\\.')}\\]`, 'm'), 'CHANGELOG có mục cho version này');
});

test('SKILL.md và README không còn tên tool cũ', () => {
  for (const f of ['skills/gdrive/SKILL.md', 'README.md', 'src/instructions.mjs']) {
    assert.doesNotMatch(read(f), /gdrive_sheet_read|gdrive_read_document|gdrive_file_info|gdrive_list|gdrive_download|gdrive_upload|gdrive_sheet_write/, f);
  }
});
```

- [ ] **Step 2: Chạy, xác nhận đỏ**

Run: `node --test test/version.test.mjs`
Expected: FAIL (version còn 0.3.0, SKILL.md còn tên cũ).

- [ ] **Step 3: Bump 0.4.0 ở 5 chỗ**

`package.json` `"version": "0.4.0"`; `.claude-plugin/plugin.json` `"version": "0.4.0"`; `server/index.mjs` `SERVER_INFO = { name: 'gdrive', version: '0.4.0' }`; frontmatter hai file `skills/*/SKILL.md` `version: 0.4.0`.

- [ ] **Step 4: Viết lại `skills/gdrive/SKILL.md`**

```markdown
---
name: gdrive
description: Dùng khi làm việc với Google Drive — người dùng dán link docs.google.com hoặc drive.google.com, hoặc nói "đọc sheet này", "lấy dữ liệu từ Google Sheet", "đọc file docx/xlsx/slide trên Drive", "ghi kết quả vào sheet", "tạo doc/sheet trong folder", "tìm file trong folder". Kèm cách xử lý lỗi ngoài phạm vi folder, 403 chưa share, và file Office đời cũ.
version: 0.4.0
---

# Google Drive qua service account, giới hạn theo folder

Plugin chỉ thấy các folder người dùng đã cho phép. Bắt đầu bằng `drive_ls` không tham số để biết
tên gợi nhớ (alias) và quyền của từng folder.

## Chọn tool nào

| Việc | Tool |
|---|---|
| Xem folder được phép, hoặc nội dung một folder | `drive_ls` |
| Đọc bất kỳ file nào: Sheet/xlsx ra TSV, Doc/Slide/docx/pptx ra markdown | `drive_read` |
| Ghi ô hoặc thêm dòng vào Google Sheet | `sheet_write` |
| Tạo folder, Google Doc (từ markdown), Google Sheet (từ CSV/TSV) | `drive_create` |
| Đổi tên, chuyển file sang folder khác | `drive_move` |

Mọi `target` nhận alias (`test-run`), đường dẫn `test-run/sub/file`, link Google dán nguyên, hoặc id.
Không thấy `sheet_write`, `drive_create`, `drive_move` nghĩa là không folder nào có quyền `write`.

## Đọc sheet lớn mà không đổ cả bảng vào context

- Dòng đầu của kết quả có `tabs: …` và `rows a-b/total · next=<offset>`. Đọc tiếp bằng
  `offset: <next>`.
- Chỉ lấy cột cần: `columns: ["ID","Trạng thái"]`. Chỉ lấy dòng cần: `where: {"Trạng thái":"FAIL"}`.
- Mặc định 200 dòng một trang, tối đa 2000.

## Lỗi hay gặp

Lỗi luôn bắt đầu bằng `✗`.

- **Ngoài phạm vi.** File không nằm trong folder được phép. Không có cách vòng: bảo người dùng
  chạy `gdrive folder add <link-folder> [--access write]` rồi thử lại.
- **Chỉ đọc.** Folder có quyền `read`. Người dùng bật ghi bằng `gdrive folder set <tên> --access write`.
- **403 chưa share.** Service account có email riêng (hiện trong lỗi); người dùng phải Share
  folder cho email đó, Viewer để đọc, Editor để ghi.
- **Chưa chắc đã ghi.** Mất kết nối giữa lúc thêm dòng. Đọc lại cuối bảng bằng `drive_read`
  trước khi gọi lại `sheet_write`, kẻo ghi trùng.
- **storageQuotaExceeded.** Service account không có dung lượng My Drive. `drive_create` chỉ
  chạy trong folder trên Shared Drive; `sheet_write` vào sheet có sẵn thì vẫn được.
- **`.doc` / `.xls` / `.ppt` đời cũ.** Cố ý không hỗ trợ. Bảo người dùng mở trong Drive, chọn
  File > Save as Google Docs/Sheets/Slides rồi đưa link mới.

## Nên làm

- Kết quả có dòng `# warnings:` thì nói lại cho người dùng.
- Link "Publish to the web" (`/d/e/2PACX-…`) không chứa file id; bảo người dùng copy link trên
  thanh địa chỉ khi mở file.
- Không bao giờ hỏi người dùng dán nội dung file key. Chưa có credential thì người dùng chạy
  `gdrive init --sa-json <đường-dẫn-key.json>` (Claude Code: skill `gdrive-setup`).
```

- [ ] **Step 5: Cập nhật `skills/gdrive-setup/SKILL.md`**

Sau bước 4 (in email service account) thêm bước:

```markdown
5. Hỏi người dùng folder nào plugin được phép đọc, folder nào được ghi, rồi thêm từng folder:
   ```bash
   gdrive folder add "<link-folder>" --access read
   gdrive folder add "<link-folder-ket-qua>" --access write
   ```
   (bản plugin Claude Code: `node "${CLAUDE_PLUGIN_ROOT}/bin/cli.mjs" folder add …`). Lệnh báo lỗi
   nếu folder chưa được share cho email ở bước 4. Chưa có folder nào thì mọi tool từ chối.
```

Đổi mục "Đổi chế độ đọc/ghi" thành "Đổi quyền từng folder": `gdrive folder set <tên> --access write`, và ghi rõ khoá `mode` cũ không còn tác dụng khi đã có folder.

- [ ] **Step 6: Viết lại README**

Viết lại `README.md` theo thứ tự trong spec mục 7, rà bằng skill `humanizer:humanizer` trước khi commit. Nội dung bắt buộc:

1. gdrive-cli là gì (3 câu).
2. **Mô hình phạm vi folder**: ví dụ config, 3 quy tắc (folder con thuộc phạm vi, danh sách rỗng chặn hết, tool ghi chỉ hiện khi có folder write), lệnh `folder add/list/set/remove`, biến `GDRIVE_FOLDERS` cho CI.
3. **Token**: bảng đo bằng tiktoken `o200k_base` ngày đo thật (chạy lại phép đo của phiên 2026-10-01 trên bộ tool mới: schema, đọc sheet 200 dòng, đọc docx, ls 10 file) so với connector Google Drive của Claude (schema ≈ 3.610, đọc xlsx ≈ 2.829, đọc docx ≈ 3.650), kèm câu: con số theo tokenizer của Claude sẽ khác, tỷ lệ thì giữ; và lệnh `npm run bench` để tự đo ước lượng.
4. **Ổn định**: timeout 30 s, thử lại tối đa 4 lần có jitter và `Retry-After`, 403 giới hạn tốc độ được thử lại, request không idempotent không gửi lại khi mất trả lời, cache metadata 5 phút và tổ tiên 10 phút, 4 request đồng thời, `GDRIVE_DEBUG=1`. Bảng độ trễ đo thật trước/sau (trước: 1,3–1,5 s mỗi lần đọc lặp lại; sau: đo lại bằng `bench.mjs` của phiên 2026-10-01 với tool mới và ghi số thật).
5. Cài đặt: Claude Code (plugin) và client khác (`npm i -g github:sdc-ren/gdrive-cli`, `gdrive init`, `gdrive folder add`, `gdrive install --client`).
6. Năm tool, bảng một dòng mỗi tool, ví dụ kết quả `drive_read` dạng TSV.
7. Giới hạn của service account, kèm kết quả bảng kiểm chứng ở Task 7.
8. Nâng cấp từ v0.3: bảng tên tool cũ → mới, bắt buộc `folder add`, `install --client` không cần chạy lại, khoá `mode` không còn tác dụng.
9. Giữ các mục Lệnh, Credential, Dùng như thư viện, Test, Đóng góp, Giấy phép (cập nhật số test).

Không dùng gạch dài trong văn xuôi, không nhãn in đậm trong danh sách, không câu "không phải X mà là Y".

- [ ] **Step 7: CHANGELOG**

Chuyển mục `[Chưa phát hành]` thành `## [0.4.0] - <ngày phát hành>` với các phần:

```markdown
### Thay đổi phá tương thích

- Mọi truy cập giới hạn trong danh sách folder. Sau khi nâng cấp phải chạy
  `gdrive folder add <url> [--access write]`; danh sách rỗng thì mọi tool từ chối.
- Tool MCP đổi: `gdrive_sheet_read`, `gdrive_read_document`, `gdrive_file_info` gộp thành
  `drive_read`; `gdrive_list` thành `drive_ls`; `gdrive_sheet_write` thành `sheet_write`;
  `gdrive_download` và `gdrive_upload` bỏ khỏi MCP (CLI `get`/`put` vẫn còn).
- Kết quả tool là văn bản thuần (TSV, markdown), không còn JSON.
- Khoá `mode` trong config không còn tác dụng khi có `folders`; quyền đặt theo từng folder.
- `createClient()` không trả `credentials` nữa; dùng `client.identity`.

### Thêm

- `drive_create` (folder, Doc từ markdown, Sheet từ CSV/TSV) và `drive_move`.
- `drive_read` lọc `columns`, `where`, phân trang `offset`/`limit`.
- `sheet_write` thêm `append`.
- `gdrive folder add/list/set/remove`; biến `GDRIVE_FOLDERS` cho CI.
- Cache metadata Drive/Sheets 5 phút và tổ tiên folder 10 phút trong MCP server.
- Timeout 30 giây, thử lại theo `Retry-After` có jitter, giới hạn 4 request đồng thời, `GDRIVE_DEBUG=1`.
- `npm run bench` đo token; CI đỏ khi schema vượt 700 token ước lượng.

### Sửa

- Drive báo giới hạn tốc độ bằng 403 `rateLimitExceeded` giờ được thử lại; trước đó bị coi là lỗi vĩnh viễn.
- Request không idempotent (`append`, tạo file) không gửi lại khi mất trả lời, tránh ghi trùng.
- Thứ tự slide pptx lấy từ `presentation.xml` thay vì số trong tên file; notes ghép qua rels.
- docx ở dạng text không còn xoá hàng bảng có số âm ở cột đầu.
- xlsx đọc `r:id` với mọi tiền tố namespace.
- Chặn file trên 50 MB và zip giải nén trên 256 MB.
- Config ghi nguyên tử với mode 600 ngay từ đầu.
- `gdrive_download` từng ghi được file tuỳ ý trên máy từ MCP, kể cả ở readonly; đã bỏ khỏi MCP.
```

Cập nhật link so sánh ở cuối file: `[0.4.0]: …/compare/v0.3.0...v0.4.0` và `[Chưa phát hành]: …/compare/v0.4.0...develop`.

- [ ] **Step 8: Chạy toàn bộ, bench, kiểm tra tay**

Run: `node --test && node bench/tokens.mjs`
Expected: PASS; bench xanh.

Chạy tay với config thật (sau khi `gdrive folder add` một folder thử):

```bash
printf '%s\n' '{"jsonrpc":"2.0","id":0,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"t","version":"1"}}}' '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"drive_ls","arguments":{}}}' | node bin/cli.mjs mcp
```

Expected: frame `initialize` có `instructions`; `drive_ls` trả `# N folders` kèm các folder đã thêm.

- [ ] **Step 9: Commit và mở PR**

```bash
git add README.md CHANGELOG.md skills package.json .claude-plugin/plugin.json server/index.mjs test/version.test.mjs
git commit -m "docs: README v0.4.0 (phạm vi folder, token, ổn định), skill mới, CHANGELOG, bump 0.4.0

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
git push -u origin <nhánh>
gh pr create --base develop --title "feat!: v0.4.0 — giới hạn theo folder, 5 tool văn bản thuần, timeout/retry/cache" --body-file <mô-tả>
```

Mô tả PR tóm tắt từ CHANGELOG, ghi rõ BREAKING CHANGE và kết quả `node bench/tokens.mjs`, kết thúc bằng `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.

---

## Self-review

**Spec coverage**
- Mục 1 (phạm vi, config, CLI folder, quy tắc, env): Task 3, 4, 10. ✓
- Mục 2 (5 tool, định dạng, lỗi `✗`, bỏ download/upload, SKILL/instructions): Task 5, 9, 13. ✓ `drive_ls` có thêm tham số `page` để dùng được `next=<token>`; spec chỉ ghi `next` mà không có cách truyền lại, đây là bổ sung cần thiết.
- Mục 3 (timeout, retry, 401, idempotent, cache, 4 đồng thời, fields, debug, 50 MB, zip bomb, atomic write, viết lại test 403): Task 1, 2, 3, 4, 8, 11. ✓ "Chỉ xin `fields` cần thiết" thực hiện qua `META_FIELDS` trong `meta.mjs`.
- Mục 3 "Sửa lỗi cùng đợt" (pptx, docx, xlsx, public API, nodeOk, MIME): Task 2, 11, 12. ✓ Map MIME trùng ở `bin/cli.mjs` `cmdGet` được thay bằng `MIME` của `formats.mjs` trong Task 10 Step 4 (thêm một dòng vào bước đó: đổi object literal `exportAs` sang dùng `MIME.PDF`, `MIME.XLSX`, `MIME.PPTX`).
- Mục 4 (kiểm chứng ghi): Task 7. ✓
- Mục 5 (test): mỗi task có test; `test/tools.test.mjs` và `test/read-document.test.mjs` đóng lỗ hổng không test lớn nhất. ✓
- Mục 6 (bench, CI gate, số đo thật trong README): Task 12, 13. ✓
- Mục 7 (README, CHANGELOG, bump, nâng cấp): Task 13. ✓

**Placeholder scan**: không có TBD/TODO; mọi bước code có code. Task 13 Step 6 mô tả nội dung README thay vì chép nguyên văn vì phần đó phải đo số liệu thật trước khi viết; các con số cần đo được nêu rõ.

**Type consistency**: `scope.resolve` trả `{ fileId, gid, root, meta }` ở Task 4 và được dùng đúng ở Task 9, 10. `meta.sheet(id)` trả `{ title, sheets[] }` theo `getMetadata`; Task 9 dùng `sm.sheets`. `viewTable` trả `{ header, rows, total, offset, limit, next }`; `renderTable` đọc đúng các trường đó. `request({ idempotent })` ở Task 1 được `client.api` chuyển tiếp ở Task 2 và `appendValues` đặt ở Task 8. `renderError(err, { email })` ở Task 5 khớp lời gọi trong `server/index.mjs` Task 9.

**Review Focus**: 1, 4, 5 trong `test/table-view.test.mjs` (Task 5); 2, 3 trong `test/scope.test.mjs` (Task 4). ✓
