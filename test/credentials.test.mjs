import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { createClient } from '../src/client.mjs';
import { adcPath, CredentialError, resolveCredentials, scopesForMode } from '../src/credentials.mjs';
import { runStatus } from '../src/status.mjs';

const PEM = '-----BEGIN PRIVATE KEY-----\\nMIIabc\\n-----END PRIVATE KEY-----\\n';
const PEM_OPEN = '-----BEGIN PRIVATE KEY-----\nMIIabc\n-----END PRIVATE KEY-----';

/** Home tạm + `run` luôn ném, để không rơi xuống gcloud thật của máy. */
function sandbox(fn) {
  const home = mkdtempSync(join(tmpdir(), 'gdrive-cred-'));
  mkdirSync(join(home, '.claude'), { recursive: true });
  const noGcloud = () => {
    throw new Error('gcloud không có');
  };
  let result;
  try {
    result = fn({ home, run: noGcloud });
  } catch (err) {
    rmSync(home, { recursive: true, force: true });
    throw err;
  }
  if (result && typeof result.then === 'function') {
    return result.finally(() => rmSync(home, { recursive: true, force: true }));
  }
  rmSync(home, { recursive: true, force: true });
  return result;
}

function sa(overrides = {}) {
  return JSON.stringify({
    type: 'service_account',
    client_email: 'sa@proj.iam.gserviceaccount.com',
    private_key: PEM,
    project_id: 'proj',
    ...overrides,
  });
}

function writeAdc(home, overrides = {}) {
  const dir = join(home, '.config', 'gcloud');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'application_default_credentials.json'),
    JSON.stringify({
      type: 'authorized_user',
      client_id: 'cid',
      client_secret: 'cs',
      refresh_token: 'rt',
      quota_project_id: 'qp',
      ...overrides,
    }),
  );
}

function writeLegacyConfig(home, cfg) {
  writeFileSync(join(home, '.claude', 'gdrive.json'), JSON.stringify(cfg));
}

function reLiteral(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

test('explicit đứng trước tất cả', () => {
  sandbox(({ home, run }) => {
    const cred = resolveCredentials({
      explicit: { clientEmail: 'x@y.z', privateKey: PEM },
      env: { GOOGLE_SERVICE_ACCOUNT_JSON: sa() },
      home,
      run,
    });
    assert.equal(cred.source, 'explicit');
    assert.equal(cred.clientEmail, 'x@y.z');
    assert.equal(cred.privateKey, PEM_OPEN, 'literal \\n phải được mở thành xuống dòng thật');
  });
});

test('GOOGLE_SERVICE_ACCOUNT_JSON: JSON thô', () => {
  sandbox(({ home, run }) => {
    const cred = resolveCredentials({ env: { GOOGLE_SERVICE_ACCOUNT_JSON: sa() }, home, run });
    assert.equal(cred.type, 'service_account');
    assert.equal(cred.clientEmail, 'sa@proj.iam.gserviceaccount.com');
    assert.equal(cred.projectId, 'proj');
  });
});

test('GOOGLE_SERVICE_ACCOUNT_JSON: base64 (dạng secret CI hay dùng)', () => {
  sandbox(({ home, run }) => {
    const b64 = Buffer.from(sa()).toString('base64');
    const cred = resolveCredentials({ env: { GOOGLE_SERVICE_ACCOUNT_JSON: b64 }, home, run });
    assert.equal(cred.clientEmail, 'sa@proj.iam.gserviceaccount.com');
  });
});

test('GOOGLE_SERVICE_ACCOUNT_JSON hỏng → lỗi nói rõ, không im lặng bỏ qua', () => {
  sandbox(({ home, run }) => {
    assert.throws(
      () => resolveCredentials({ env: { GOOGLE_SERVICE_ACCOUNT_JSON: 'rác' }, home, run }),
      CredentialError,
    );
  });
});

test('cặp GOOGLE_* rời', () => {
  sandbox(({ home, run }) => {
    const cred = resolveCredentials({
      env: { GOOGLE_SERVICE_ACCOUNT_EMAIL: 'a@b.c', GOOGLE_PRIVATE_KEY: PEM },
      home,
      run,
    });
    assert.equal(cred.source, 'GOOGLE_SERVICE_ACCOUNT_EMAIL+GOOGLE_PRIVATE_KEY');
  });
});

// Tên packflow đang dùng — giữ vĩnh viễn để redact.mjs của packflow không hỏng âm thầm.
test('cặp DRIVE_* (tên packflow) vẫn là first-class', () => {
  sandbox(({ home, run }) => {
    const cred = resolveCredentials({
      env: { DRIVE_SERVICE_ACCOUNT_EMAIL: 'qc@rv.iam.gserviceaccount.com', DRIVE_PRIVATE_KEY: PEM },
      home,
      run,
    });
    assert.equal(cred.clientEmail, 'qc@rv.iam.gserviceaccount.com');
    assert.equal(cred.privateKey, PEM_OPEN);
  });
});

test('GOOGLE_* thắng DRIVE_* khi có cả hai', () => {
  sandbox(({ home, run }) => {
    const cred = resolveCredentials({
      env: {
        GOOGLE_SERVICE_ACCOUNT_EMAIL: 'new@x.com',
        GOOGLE_PRIVATE_KEY: PEM,
        DRIVE_SERVICE_ACCOUNT_EMAIL: 'old@x.com',
        DRIVE_PRIVATE_KEY: PEM,
      },
      home,
      run,
    });
    assert.equal(cred.clientEmail, 'new@x.com');
  });
});

test('GOOGLE_APPLICATION_CREDENTIALS trỏ tới file key', () => {
  sandbox(({ home, run }) => {
    const file = join(home, 'key.json');
    writeFileSync(file, sa());
    const cred = resolveCredentials({ env: { GOOGLE_APPLICATION_CREDENTIALS: file }, home, run });
    assert.equal(cred.source, 'GOOGLE_APPLICATION_CREDENTIALS');
    assert.equal(cred.clientEmail, 'sa@proj.iam.gserviceaccount.com');
  });
});

test('GOOGLE_APPLICATION_CREDENTIALS trỏ tới authorized_user vẫn là chỉ định tường minh', () => {
  sandbox(({ home, run }) => {
    const file = join(home, 'adc.json');
    writeFileSync(
      file,
      JSON.stringify({
        type: 'authorized_user',
        client_id: 'cid',
        client_secret: 'cs',
        refresh_token: 'rt',
        quota_project_id: 'qp',
      }),
    );
    const cred = resolveCredentials({ env: { GOOGLE_APPLICATION_CREDENTIALS: file }, home, run });
    assert.equal(cred.type, 'authorized_user');
    assert.equal(cred.source, 'GOOGLE_APPLICATION_CREDENTIALS');
    assert.equal(cred.quotaProjectId, 'qp');
  });
});

test('config: đọc được cả vị trí CŨ lẫn thư mục data plugin, báo ĐÚNG nguồn', () => {
  sandbox(({ home, run }) => {
    // Vị trí cũ (bản cài npx) — người đã cài kiểu cũ không được mất cấu hình.
    writeFileSync(
      join(home, '.claude', 'gdrive.json'),
      JSON.stringify({ clientEmail: 'cu@x.com', privateKey: PEM, mode: 'readonly' }),
    );
    let cred = resolveCredentials({ env: {}, home, run });
    assert.equal(cred.clientEmail, 'cu@x.com');
    assert.match(cred.source, /gdrive\.json$/);

    // Config plugin THẮNG, và source phải trỏ đúng file đang dùng.
    const dataDir = join(home, '.claude', 'plugins', 'data', 'gdrive-gdrive-cli');
    const dataFile = join(dataDir, 'config.json');
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(
      dataFile,
      JSON.stringify({ clientEmail: 'moi@x.com', privateKey: PEM, mode: 'readonly' }),
    );
    cred = resolveCredentials({ env: {}, home, run });
    assert.equal(cred.clientEmail, 'moi@x.com');
    assert.equal(cred.source, dataFile);
  });
});

test('config: env trỏ thư mục rỗng nhưng source vẫn là file plugin thật đã đọc', () => {
  sandbox(({ home, run }) => {
    const actualDir = join(home, '.claude', 'plugins', 'data', 'gdrive-inline');
    const actualFile = join(actualDir, 'config.json');
    const emptyEnvDir = join(home, '.claude', 'plugins', 'data', 'gdrive-empty');
    mkdirSync(actualDir, { recursive: true });
    mkdirSync(emptyEnvDir, { recursive: true });
    writeFileSync(
      actualFile,
      JSON.stringify({ clientEmail: 'inline@x.com', privateKey: PEM, mode: 'readonly' }),
    );

    const cred = resolveCredentials({ env: { CLAUDE_PLUGIN_DATA: emptyEnvDir }, home, run });
    assert.equal(cred.clientEmail, 'inline@x.com');
    assert.equal(cred.source, actualFile);
  });
});

test('config: chỉ có vị trí legacy thì source là đúng file legacy', () => {
  sandbox(({ home, run }) => {
    const legacyFile = join(home, '.claude', 'gdrive.json');
    writeFileSync(legacyFile, JSON.stringify({ clientEmail: 'legacy@x.com', privateKey: PEM }));

    const cred = resolveCredentials({ env: {}, home, run });
    assert.equal(cred.clientEmail, 'legacy@x.com');
    assert.equal(cred.source, legacyFile);
  });
});

test('env thắng config — CI không có ~/.claude nhưng máy dev thì có cả hai', () => {
  sandbox(({ home, run }) => {
    writeFileSync(
      join(home, '.claude', 'gdrive.json'),
      JSON.stringify({ clientEmail: 'cfg@x.com', privateKey: PEM }),
    );
    const cred = resolveCredentials({
      env: { DRIVE_SERVICE_ACCOUNT_EMAIL: 'env@x.com', DRIVE_PRIVATE_KEY: PEM },
      home,
      run,
    });
    assert.equal(cred.clientEmail, 'env@x.com');
  });
});

test('ADC authorized_user', () => {
  sandbox(({ home, run }) => {
    writeAdc(home);
    writeLegacyConfig(home, { useAdc: true });
    const cred = resolveCredentials({ env: {}, home, run });
    assert.equal(cred.type, 'authorized_user');
    assert.equal(cred.quotaProjectId, 'qp');
  });
});

test('ADC authorized_user mặc định bị tắt và lỗi chỉ cách bật lại', () => {
  sandbox(({ home, run }) => {
    writeAdc(home);
    assert.throws(() => resolveCredentials({ env: {}, home, run }), (err) => {
      assert.ok(err instanceof CredentialError);
      assert.match(err.message, /init --adc/);
      assert.match(err.message, /danh tính cá nhân/);
      return true;
    });
  });
});

test('allowAdc bật được ADC mà không cần config', () => {
  sandbox(({ home, run }) => {
    writeAdc(home);
    const cred = resolveCredentials({ env: {}, home, run, allowAdc: true });
    assert.equal(cred.type, 'authorized_user');
    assert.equal(cred.quotaProjectId, 'qp');
  });
});

test('createClient forward allowAdc xuống resolveCredentials', () => {
  sandbox(({ home }) => {
    writeAdc(home);
    const client = createClient({ env: {}, home, allowAdc: true });
    assert.equal(client.credentials.type, 'authorized_user');
  });
});

test('CLOUDSDK_CONFIG đổi vị trí file ADC', () => {
  assert.equal(
    adcPath({ CLOUDSDK_CONFIG: '/custom/gcloud' }, '/home/u'),
    join('/custom/gcloud', 'application_default_credentials.json'),
  );
});

test('gcloud print-access-token là cứu cánh cuối', () => {
  sandbox(({ home }) => {
    writeLegacyConfig(home, { useAdc: true });
    const cred = resolveCredentials({
      env: {},
      home,
      run: () => 'ya29.fake-token\n',
    });
    assert.equal(cred.type, 'access_token');
    assert.equal(cred.token, 'ya29.fake-token');
  });
});

test('gcloud print-access-token mặc định bị tắt', () => {
  sandbox(({ home }) => {
    let calls = 0;
    const run = () => {
      calls += 1;
      return 'ya29.fake-token\n';
    };
    assert.throws(
      () => resolveCredentials({ env: {}, home, run }),
      CredentialError,
    );
    assert.equal(calls, 0);
  });
});

test('không có gì → lỗi liệt kê đủ cách khắc phục', () => {
  sandbox(({ home, run }) => {
    assert.throws(() => resolveCredentials({ env: {}, home, run }), (err) => {
      assert.ok(err instanceof CredentialError);
      assert.match(err.message, /gdrive-setup/);
      assert.match(err.message, /GOOGLE_SERVICE_ACCOUNT_JSON/);
      assert.match(err.message, /DRIVE_SERVICE_ACCOUNT_EMAIL/);
      assert.match(err.message, /gcloud auth application-default login/);
      assert.match(err.message, /init --adc/);
      return true;
    });
  });
});

test('scope theo mode', () => {
  assert.deepEqual(scopesForMode('readonly'), [
    'https://www.googleapis.com/auth/drive.readonly',
    'https://www.googleapis.com/auth/spreadsheets.readonly',
  ]);
  assert.deepEqual(scopesForMode('readwrite'), [
    'https://www.googleapis.com/auth/drive',
    'https://www.googleapis.com/auth/spreadsheets',
  ]);
  assert.deepEqual(scopesForMode(undefined), scopesForMode('readonly'), 'mặc định là readonly');
});

test('status cảnh báo scope khi credential không phải service account', async () => {
  await sandbox(async ({ home }) => {
    writeAdc(home);
    writeLegacyConfig(home, { useAdc: true, mode: 'readonly' });
    const logs = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      if (String(url).includes('/token')) {
        return new Response(JSON.stringify({ access_token: 'ya29.fake', expires_in: 3600 }), { status: 200 });
      }
      return new Response(
        JSON.stringify({
          user: { emailAddress: 'user@example.com' },
          storageQuota: { limit: '1' },
        }),
        { status: 200 },
      );
    };
    try {
      await runStatus({ home, env: {}, log: (line) => logs.push(line) });
    } finally {
      globalThis.fetch = originalFetch;
    }
    const output = logs.join('\n');
    assert.match(output, /readonly KHÔNG giới hạn scope thật/);
    assert.match(output, /tool ghi bị ẩn/);
  });
});

test('status: Windows cảnh báo ACL kèm lệnh icacls', async () => {
  await sandbox(async ({ home }) => {
    const dir = join(home, '.claude', 'plugins', 'data', 'gdrive-gdrive-cli');
    const file = join(dir, 'config.json');
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, JSON.stringify({ clientEmail: 'sa@x.com', privateKey: PEM, mode: 'readonly' }));
    const logs = [];
    await runStatus({
      home,
      env: {},
      platform: 'win32',
      log: (line) => logs.push(line),
    });
    const output = logs.join('\n');
    assert.match(output, /Windows không set được chmod 600/);
    assert.match(output, /icacls/);
    assert.match(output, /%USERNAME%:F/);
  });
});

test('status: Node dưới 18.17 báo đỏ', async () => {
  await sandbox(async ({ home }) => {
    const logs = [];
    await runStatus({ home, env: {}, version: 'v18.16.0', log: (line) => logs.push(line) });
    const output = logs.join('\n');
    assert.match(output, /❌ Node\.js: v18\.16\.0/);
    assert.match(output, /cần Node >= 18\.17/);
  });
});

test('status: nhiều config plugin thì nêu file đang dùng và file thừa', async () => {
  await sandbox(async ({ home }) => {
    const root = join(home, '.claude', 'plugins', 'data');
    const active = join(root, 'gdrive-gdrive-cli', 'config.json');
    const stale = join(root, 'gdrive-inline', 'config.json');
    mkdirSync(join(root, 'gdrive-gdrive-cli'), { recursive: true });
    mkdirSync(join(root, 'gdrive-inline'), { recursive: true });
    writeFileSync(active, JSON.stringify({ clientEmail: 'active@x.com', privateKey: PEM, mode: 'readonly' }));
    writeFileSync(stale, JSON.stringify({ clientEmail: 'stale@x.com', privateKey: PEM, mode: 'readonly' }));
    const logs = [];
    await runStatus({ home, env: {}, log: (line) => logs.push(line) });
    const output = logs.join('\n');
    assert.match(output, /config plugin chứa private key/);
    assert.match(output, new RegExp(`ĐANG dùng: ${reLiteral(active)}`));
    assert.match(output, new RegExp(`bản thừa: ${reLiteral(stale)}`));
  });
});

test('status: active config trong CLAUDE_PLUGIN_DATA ngoài gdrive* không bị gắn nhãn bản thừa', async () => {
  await sandbox(async ({ home }) => {
    const root = join(home, '.claude', 'plugins', 'data');
    const activeDir = join(root, 'custom-data-name');
    const staleDir = join(root, 'gdrive-inline');
    const active = join(activeDir, 'config.json');
    const stale = join(staleDir, 'config.json');
    mkdirSync(activeDir, { recursive: true });
    mkdirSync(staleDir, { recursive: true });
    writeFileSync(active, JSON.stringify({ clientEmail: 'active@x.com', privateKey: PEM, mode: 'readonly' }));
    writeFileSync(stale, JSON.stringify({ clientEmail: 'stale@x.com', privateKey: PEM, mode: 'readonly' }));
    const logs = [];

    await runStatus({
      home,
      env: { CLAUDE_PLUGIN_DATA: activeDir },
      log: (line) => logs.push(line),
    });

    const output = logs.join('\n');
    assert.match(output, new RegExp(`ĐANG dùng: ${reLiteral(active)}`));
    assert.match(output, new RegExp(`bản thừa: ${reLiteral(stale)}`));
  });
});

test('status không cảnh báo scope khi credential là service account', async () => {
  await sandbox(async ({ home }) => {
    const { privateKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    });
    writeLegacyConfig(home, {
      clientEmail: 'sa@proj.iam.gserviceaccount.com',
      privateKey,
      mode: 'readonly',
    });
    const logs = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      if (String(url).includes('/token')) {
        return new Response(JSON.stringify({ access_token: 'ya29.fake', expires_in: 3600 }), { status: 200 });
      }
      return new Response(
        JSON.stringify({
          user: { emailAddress: 'sa@proj.iam.gserviceaccount.com' },
          storageQuota: { limit: '0' },
        }),
        { status: 200 },
      );
    };
    try {
      await runStatus({ home, env: {}, log: (line) => logs.push(line) });
    } finally {
      globalThis.fetch = originalFetch;
    }
    const output = logs.join('\n');
    assert.doesNotMatch(output, /readonly KHÔNG giới hạn scope thật/);
    assert.match(output, /Scope: https:\/\/www.googleapis.com\/auth\/drive\.readonly/);
  });
});
