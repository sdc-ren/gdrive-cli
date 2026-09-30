// Tìm credential theo thứ tự ưu tiên, chuẩn hoá về một shape duy nhất cho auth.mjs.
//
// Env đứng TRƯỚC file config là cố ý: CI không có ~/.claude nhưng có secret trong env.
// Cặp DRIVE_* (#4) là tên packflow đang dùng — giữ vĩnh viễn, vì đổi tên env key sẽ làm
// hỏng redaction log của packflow (scripts/lib/redact.mjs gom secret theo đúng tên này)
// một cách âm thầm trong khi test vẫn xanh.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { readConfigWithSource } from './config.mjs';

export class CredentialError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CredentialError';
  }
}

export const SCOPES = {
  readonly: [
    'https://www.googleapis.com/auth/drive.readonly',
    'https://www.googleapis.com/auth/spreadsheets.readonly',
  ],
  readwrite: [
    'https://www.googleapis.com/auth/drive',
    'https://www.googleapis.com/auth/spreadsheets',
  ],
};

export function scopesForMode(mode) {
  return SCOPES[mode === 'readwrite' ? 'readwrite' : 'readonly'];
}

/** PEM lưu trong env/JSON có `\n` dạng literal — mọi consumer đều phải mở lại. */
function normalizeKey(key) {
  return String(key).replace(/\\n/g, '\n').trim();
}

function fromServiceAccountObject(obj, source) {
  if (!obj || obj.type !== 'service_account') return null;
  if (!obj.client_email || !obj.private_key) {
    throw new CredentialError(
      `${source}: thiếu client_email hoặc private_key trong JSON service account.`,
    );
  }
  return {
    type: 'service_account',
    clientEmail: obj.client_email,
    privateKey: normalizeKey(obj.private_key),
    projectId: obj.project_id ?? null,
    source,
  };
}

function fromAuthorizedUserObject(obj, source) {
  if (!obj || obj.type !== 'authorized_user') return null;
  return {
    type: 'authorized_user',
    clientId: obj.client_id,
    clientSecret: obj.client_secret,
    refreshToken: obj.refresh_token,
    quotaProjectId: obj.quota_project_id ?? null,
    source,
  };
}

/** Chấp nhận JSON thô hoặc base64 (secret CI hay được base64 hoá cho khỏi vỡ newline). */
function parseJsonMaybeBase64(raw, source) {
  const text = String(raw).trim();
  try {
    return JSON.parse(text);
  } catch {
    /* thử base64 */
  }
  try {
    return JSON.parse(Buffer.from(text, 'base64').toString('utf8'));
  } catch {
    throw new CredentialError(`${source}: không parse được (không phải JSON, cũng không phải base64 của JSON).`);
  }
}

function readJsonFile(file, source) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (err) {
    throw new CredentialError(`${source}: không đọc được ${file} (${err.code ?? err.message}).`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new CredentialError(`${source}: ${file} không phải JSON hợp lệ.`);
  }
}

/** Đường dẫn file ADC của gcloud, theo đúng thứ tự gcloud tự tra. */
export function adcPath(env = process.env, home = homedir()) {
  if (env.CLOUDSDK_CONFIG) {
    return join(env.CLOUDSDK_CONFIG, 'application_default_credentials.json');
  }
  if (process.platform === 'win32' && env.APPDATA) {
    return join(env.APPDATA, 'gcloud', 'application_default_credentials.json');
  }
  return join(home, '.config', 'gcloud', 'application_default_credentials.json');
}

/**
 * @returns {{type:string, source:string, [k:string]: any}}
 * @throws {CredentialError} khi không tìm thấy gì — message liệt kê đủ các cách khắc phục.
 */
export function resolveCredentials({
  explicit = null,
  env = process.env,
  home = homedir(),
  run = execFileSync,
  allowAdc = false,
} = {}) {
  // 1. Truyền thẳng vào (test, hoặc caller đã có sẵn).
  if (explicit) {
    if (explicit.clientEmail && explicit.privateKey) {
      return {
        type: 'service_account',
        clientEmail: explicit.clientEmail,
        privateKey: normalizeKey(explicit.privateKey),
        projectId: explicit.projectId ?? null,
        source: 'explicit',
      };
    }
    if (explicit.accessToken) {
      return { type: 'access_token', token: explicit.accessToken, source: 'explicit' };
    }
    throw new CredentialError('explicit: cần {clientEmail, privateKey} hoặc {accessToken}.');
  }

  // 2. Cả JSON key trong một biến — dạng thân thiện với CI nhất.
  if (env.GOOGLE_SERVICE_ACCOUNT_JSON) {
    const obj = parseJsonMaybeBase64(env.GOOGLE_SERVICE_ACCOUNT_JSON, 'GOOGLE_SERVICE_ACCOUNT_JSON');
    const sa = fromServiceAccountObject(obj, 'GOOGLE_SERVICE_ACCOUNT_JSON');
    if (sa) return sa;
    throw new CredentialError('GOOGLE_SERVICE_ACCOUNT_JSON: type phải là "service_account".');
  }

  // 3 + 4. Cặp email/key rời. DRIVE_* là tên packflow đang dùng.
  const pairs = [
    ['GOOGLE_SERVICE_ACCOUNT_EMAIL', 'GOOGLE_PRIVATE_KEY'],
    ['DRIVE_SERVICE_ACCOUNT_EMAIL', 'DRIVE_PRIVATE_KEY'],
  ];
  for (const [emailKey, keyKey] of pairs) {
    if (env[emailKey] && env[keyKey]) {
      return {
        type: 'service_account',
        clientEmail: env[emailKey],
        privateKey: normalizeKey(env[keyKey]),
        projectId: null,
        source: `${emailKey}+${keyKey}`,
      };
    }
  }

  // 5. Đường dẫn tới file key (chuẩn của Google SDK).
  if (env.GOOGLE_APPLICATION_CREDENTIALS) {
    const obj = readJsonFile(env.GOOGLE_APPLICATION_CREDENTIALS, 'GOOGLE_APPLICATION_CREDENTIALS');
    const cred =
      fromServiceAccountObject(obj, 'GOOGLE_APPLICATION_CREDENTIALS') ??
      fromAuthorizedUserObject(obj, 'GOOGLE_APPLICATION_CREDENTIALS');
    if (cred) return cred;
    throw new CredentialError(
      `GOOGLE_APPLICATION_CREDENTIALS: type "${obj?.type}" không hỗ trợ (cần service_account hoặc authorized_user).`,
    );
  }

  // 6. Config của plugin (hoặc vị trí cũ). Vắng mặt trong CI — đúng như thiết kế.
  const cfgWithSource = readConfigWithSource(home, env);
  const cfg = cfgWithSource?.config ?? null;
  if (cfg?.clientEmail && cfg?.privateKey) {
    return {
      type: 'service_account',
      clientEmail: cfg.clientEmail,
      privateKey: normalizeKey(cfg.privateKey),
      projectId: cfg.projectId ?? null,
      // Báo ĐÚNG file đang dùng — nhãn cứng từng khiến status nói sai nguồn.
      source: cfgWithSource.path,
    };
  }

  // 7. ADC của gcloud.
  const adc = adcPath(env, home);
  const useAdc = allowAdc === true || cfg?.useAdc === true;
  const hasAdc = existsSync(adc);
  if (useAdc && hasAdc) {
    const obj = readJsonFile(adc, 'ADC');
    const cred = fromAuthorizedUserObject(obj, 'ADC') ?? fromServiceAccountObject(obj, 'ADC');
    if (cred) return cred;
  }

  // 8. Cứu cánh cuối: nhờ gcloud in token ra. Chậm (~700ms) nên để cuối cùng.
  if (useAdc) {
    try {
      const token = String(run('gcloud', ['auth', 'print-access-token'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      })).trim();
      if (token) return { type: 'access_token', token, source: 'gcloud print-access-token' };
    } catch {
      /* gcloud không có hoặc chưa login — rơi xuống lỗi bên dưới */
    }
  }

  const disabledAdcNote = hasAdc && !useAdc
    ? '\n\nĐã phát hiện ADC của gcloud nhưng KHÔNG dùng. ADC/gcloud thường chạy bằng danh tính cá nhân của bạn, không phải service account; muốn bật nguồn này thì chạy `gdrive init --adc`.'
    : '';

  throw new CredentialError(
    'Không tìm thấy credential Google. Chọn một trong các cách sau:\n' +
      '  • Trong Claude Code: chạy skill /gdrive-setup\n' +
      '  • Hoặc tay:     gdrive init --sa-json <đường-dẫn-key.json>\n' +
      '  • Đặt env:      GOOGLE_SERVICE_ACCOUNT_JSON=<nội dung file key JSON>\n' +
      '  • Hoặc cặp:     DRIVE_SERVICE_ACCOUNT_EMAIL + DRIVE_PRIVATE_KEY\n' +
      '  • Hoặc file:    GOOGLE_APPLICATION_CREDENTIALS=/đường/dẫn/key.json\n' +
      '  • Hoặc gcloud:  gcloud auth application-default login \\\n' +
      '                    --scopes=https://www.googleapis.com/auth/drive,' +
      'https://www.googleapis.com/auth/spreadsheets,https://www.googleapis.com/auth/cloud-platform\n' +
      '                    rồi chạy `gdrive init --adc` để bật nguồn này (ADC/gcloud dùng danh tính cá nhân, không phải service account)' +
      disabledAdcNote,
  );
}
