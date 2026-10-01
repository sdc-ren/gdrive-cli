// Lấy access token Google mà KHÔNG cần googleapis (207 MB giải nén).
//
// Luồng two-legged JWT-bearer: tự ký RS256 bằng node:crypto rồi đổi lấy access token.
// Toàn bộ nằm gọn trong ~60 dòng ký + đổi + cache.

import { createSign } from 'node:crypto';

import { GoogleApiError, request } from './http.mjs';

export const TOKEN_URL = 'https://oauth2.googleapis.com/token';

const JWT_LIFETIME_SEC = 3600;
// Trả token về sớm hơn hạn 60s để một request đang bay không chết giữa chừng vì token
// hết hạn ngay sau khi ta kiểm tra.
const EXPIRY_SKEW_MS = 60_000;

const tokenCache = new Map();

/** Chỉ dùng trong test — xoá cache token toàn tiến trình. */
export function _clearTokenCache() {
  tokenCache.clear();
}

function b64url(input) {
  return Buffer.from(input).toString('base64url');
}

/**
 * Ký JWT assertion cho luồng service account.
 * Tách riêng để test verify được chữ ký bằng nửa public của một keypair sinh tại chỗ.
 */
export function signJwt({ clientEmail, privateKey, scopes, subject = null, nowSec }) {
  const iat = nowSec;
  const claim = {
    iss: clientEmail,
    scope: Array.isArray(scopes) ? scopes.join(' ') : String(scopes),
    aud: TOKEN_URL,
    exp: iat + JWT_LIFETIME_SEC,
    iat,
  };
  // Chỉ có khi impersonate người dùng trong Workspace (domain-wide delegation).
  if (subject) claim.sub = subject;

  const signingInput = `${b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${b64url(
    JSON.stringify(claim),
  )}`;

  let signature;
  try {
    signature = createSign('RSA-SHA256').update(signingInput).sign(privateKey);
  } catch (err) {
    throw new Error(
      `Không ký được JWT — private key hỏng hoặc sai định dạng PEM (${err.message}).\n` +
        'Kiểm tra private_key có đủ hai dòng BEGIN/END PRIVATE KEY, và các "\\n" đã được ' +
        'mở thành xuống dòng thật chưa.',
    );
  }
  return `${signingInput}.${signature.toString('base64url')}`;
}

function cacheKey(credentials, scopes, subject) {
  const identity =
    credentials.type === 'service_account'
      ? credentials.clientEmail
      : credentials.type === 'authorized_user'
        ? credentials.clientId
        : 'static';
  return [credentials.type, identity, subject ?? '', [...scopes].sort().join(' ')].join('|');
}

/**
 * Tạo nguồn token cho một bộ credential đã chuẩn hoá (xem credentials.mjs).
 *
 * @param {object} credentials
 * @param {object} [opts]
 * @param {typeof fetch} [opts.fetchImpl]
 * @param {() => number} [opts.now] trả về ms epoch — inject được để test hạn token
 */
export function createTokenSource(credentials, { fetchImpl = fetch, now = Date.now } = {}) {
  const subject = credentials.subject ?? null;

  async function fetchToken(scopes) {
    if (credentials.type === 'access_token') {
      // gcloud đưa token trần, không kèm hạn. Coi như sống 30 phút — nếu hết hạn sớm hơn
      // thì lần gọi sau nhận 401 và người dùng chạy lại gcloud.
      return { token: credentials.token, expiresAt: now() + 30 * 60_000 };
    }

    let body;
    if (credentials.type === 'service_account') {
      const assertion = signJwt({
        clientEmail: credentials.clientEmail,
        privateKey: credentials.privateKey,
        scopes,
        subject,
        nowSec: Math.floor(now() / 1000),
      });
      body = new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion,
      }).toString();
    } else if (credentials.type === 'authorized_user') {
      body = new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: credentials.clientId,
        client_secret: credentials.clientSecret,
        refresh_token: credentials.refreshToken,
      }).toString();
    } else {
      throw new Error(`Loại credential không hỗ trợ: ${credentials.type}`);
    }

    let res;
    try {
      res = await request({
        url: TOKEN_URL,
        method: 'POST',
        body,
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        fetchImpl,
        retries: 2,
      });
    } catch (err) {
      throw explainTokenError(err, credentials);
    }

    return {
      token: res.access_token,
      expiresAt: now() + Number(res.expires_in ?? 3600) * 1000,
    };
  }

  return {
    quotaProjectId: credentials.quotaProjectId ?? null,

    /** Vứt token đang cache — dùng khi API trả 401 để thử lại đúng một lần. */
    invalidate(scopes) {
      tokenCache.delete(cacheKey(credentials, scopes, subject));
    },

    async getToken(scopes) {
      const key = cacheKey(credentials, scopes, subject);
      const hit = tokenCache.get(key);

      if (hit) {
        // Promise đang bay: mọi caller cùng chờ một lần đổi token, không dẫm lên nhau.
        if (typeof hit.then === 'function') return hit;
        if (hit.expiresAt - EXPIRY_SKEW_MS > now()) return hit.token;
      }

      const inflight = fetchToken(scopes)
        .then((entry) => {
          tokenCache.set(key, entry);
          return entry.token;
        })
        .catch((err) => {
          tokenCache.delete(key);
          throw err;
        });

      tokenCache.set(key, inflight);
      return inflight;
    },
  };
}

/** Biến lỗi OAuth khô khan thành thứ đọc xong biết phải làm gì. */
function explainTokenError(err, credentials) {
  if (!(err instanceof GoogleApiError)) return err;
  const reason = String(err.reason ?? '');
  const hints = [];

  if (reason === 'invalid_grant') {
    if (credentials.type === 'service_account') {
      hints.push(
        'Thường do 1 trong 3: (a) đồng hồ máy lệch quá 5 phút so với giờ thật, ' +
          '(b) service account đã bị xoá/vô hiệu hoá, (c) key đã bị xoá trong GCP Console.',
      );
    } else {
      hints.push('Refresh token đã hết hiệu lực — chạy lại: gcloud auth application-default login');
    }
  }
  if (reason === 'invalid_client') {
    hints.push('client_email hoặc client_id không khớp với key đang dùng.');
  }
  if (reason === 'invalid_scope') {
    hints.push(
      'Scope chưa được cấp. Với ADC phải login lại kèm scope:\n' +
        '  gcloud auth application-default login --scopes=https://www.googleapis.com/auth/drive,' +
        'https://www.googleapis.com/auth/spreadsheets,https://www.googleapis.com/auth/cloud-platform',
    );
  }

  if (!hints.length) return err;
  const wrapped = new GoogleApiError(err.status, err.response.data, {
    url: err.url,
    method: err.method,
  });
  wrapped.message = `${err.message}\n${hints.join('\n')}`;
  return wrapped;
}
