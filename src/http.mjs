// Lớp transport: fetch + chuẩn hoá lỗi.
//
// HỢP ĐỒNG LỖI — load-bearing, đừng đổi:
// packflow/scripts/lib/sheets-retry.mjs phân loại lỗi tạm thời bằng
//   Number(error?.code ?? error?.response?.status)
// nên lỗi ném ra BẮT BUỘC có `.code` là SỐ và `.response.status`. Sai shape thì mọi lỗi
// bị coi là non-transient, packflow mất cơ chế retry mà test vẫn xanh.

export class GoogleApiError extends Error {
  constructor(status, body, { url, method, retryAfter = null } = {}) {
    const raw = body && typeof body === 'object' ? body.error : null;
    // Endpoint OAuth trả `{error: "invalid_grant", error_description: "..."}` (error là
    // CHUỖI), còn REST API trả `{error: {message, errors[]}}` (error là OBJECT).
    const isOauthShape = typeof raw === 'string';
    const apiError = isOauthShape ? null : raw;
    const message =
      (isOauthShape && (body.error_description || raw)) ||
      (apiError && (apiError.message || apiError.error_description)) ||
      (typeof body === 'string' && body.trim()) ||
      `HTTP ${status}`;
    super(message);
    this.name = 'GoogleApiError';
    this.code = status; // SỐ — sheets-retry.mjs đọc field này trước tiên
    this.status = status;
    this.response = { status, data: body };
    this.errors = (apiError && apiError.errors) || [];
    this.reason = this.errors[0]?.reason ?? apiError?.status ?? (isOauthShape ? raw : null);
    this.url = url;
    this.method = method;
    this.retryAfter = retryAfter;
  }
}

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
  // Message của UncertainWriteError chứa message gốc ("fetch failed"...) — không được để
  // tầng retry bên ngoài coi là tạm thời rồi gửi lại một request có thể đã ghi.
  if (error?.code === 'UNCERTAIN_WRITE' || error instanceof UncertainWriteError) return false;
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

/** Bỏ key undefined/null rồi build query string. */
export function buildQuery(params = {}) {
  const usp = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      for (const item of value) usp.append(key, String(item));
    } else {
      usp.append(key, String(value));
    }
  }
  const qs = usp.toString();
  return qs ? `?${qs}` : '';
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
 * `retries` mặc định 0: packflow tự bọc withSheetsRetry ở tầng trên, retry cả hai tầng sẽ
 * nhân số lần gọi. CLI thì truyền retries=2.
 *
 * @param {object} opts
 * @param {string} opts.url            URL đầy đủ (đã kèm query nếu có)
 * @param {string} [opts.method]
 * @param {string} [opts.token]        access token
 * @param {object|string|Uint8Array} [opts.body]
 * @param {Record<string,string>} [opts.headers]
 * @param {'json'|'buffer'|'text'|'raw'} [opts.responseType]
 * @param {number} [opts.retries]        mặc định 0 — thư viện tự retry ở tầng trên
 * @param {number} [opts.timeoutMs]      mặc định 30 giây; <= 0 = không timeout (không gắn AbortSignal)
 * @param {boolean} [opts.idempotent]    false cho append/create: không gửi lại khi mất trả lời
 * @param {typeof fetch} [opts.fetchImpl]
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

  // Timer thường (có ref) thay vì AbortSignal.timeout(): timer của AbortSignal.timeout bị
  // unref trên Node 18/22, nên khi không còn gì khác giữ event loop (như fetch giả trong
  // test) tiến trình thoát trước khi timeout bắn. Một timer bao trọn cả fetch lẫn đọc body,
  // và mọi bước await đều đổi abort thành TimeoutError.
  const ac = new AbortController();
  const timer = timeoutMs > 0 ? setTimeout(() => ac.abort(), timeoutMs) : null;
  const guard = async (fn) => {
    try {
      return await fn();
    } catch (err) {
      if (ac.signal.aborted || err?.name === 'TimeoutError' || err?.name === 'AbortError') {
        throw new TimeoutError(url, method, timeoutMs);
      }
      throw err;
    }
  };

  try {
    const res = await guard(() =>
      fetchImpl(url, { method, headers: finalHeaders, body: payload, signal: timer ? ac.signal : undefined }),
    );

    if (!res.ok) {
      // Lỗi của Google luôn là JSON, nhưng 5xx từ load balancer có thể là HTML.
      const text = await guard(() => res.text()).catch((err) => {
        if (err instanceof TimeoutError) throw err;
        return '';
      });
      let parsed = text;
      try {
        parsed = JSON.parse(text);
      } catch {
        /* giữ nguyên text */
      }
      throw new GoogleApiError(res.status, parsed, { url, method, retryAfter: res.headers?.get?.('retry-after') ?? null });
    }

    // 'raw' cho những chỗ cần header (upload resumable đọc Location).
    if (responseType === 'raw') return res;
    if (responseType === 'buffer') return Buffer.from(await guard(() => res.arrayBuffer()));
    if (responseType === 'text') return guard(() => res.text());
    const text = await guard(() => res.text());
    return text ? JSON.parse(text) : {};
  } finally {
    if (timer) clearTimeout(timer);
  }
}
