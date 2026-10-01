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
