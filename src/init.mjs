// Cấu hình credential cho plugin.
//
// Từ v0.2 việc CÀI ĐẶT do cơ chế plugin của Claude Code lo (`/plugin install`), nên file
// này chỉ còn một việc: xác thực rồi ghi credential vào thư mục data của plugin.
// Không copy code, không cài skill, không sửa settings.json — MCP tool không cần allow-rule.

import { createPrivateKey } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { createInterface } from 'node:readline/promises';

import { about } from './drive.mjs';
import { createClient } from './client.mjs';
import { hasLegacyInstall, pluginDataDir, readConfig, writeConfig } from './config.mjs';

const GCP_GUIDE = `
  Tạo service account (khoảng 5 phút, làm một lần):

   1. https://console.cloud.google.com/ → tạo project (hoặc chọn project có sẵn).
   2. Bật API — PHẢI bật CẢ HAI:
        https://console.cloud.google.com/apis/library/drive.googleapis.com
        https://console.cloud.google.com/apis/library/sheets.googleapis.com
   3. IAM & Admin → Service Accounts → Create → Done (không cần cấp role).
   4. Bấm vào service account → tab Keys → Add key → Create new key → JSON → file tự tải về.

  ⚠️  Điều quan trọng nhất, hay bị bỏ sót:
      Service account là MỘT DANH TÍNH RIÊNG, có email riêng (…iam.gserviceaccount.com).
      Nó KHÔNG thấy gì trong Drive của bạn cho tới khi bạn Share file/thư mục cho email đó
      — Viewer để đọc, Editor để ghi. Y như share cho một đồng nghiệp.
`;

/** Validate TRƯỚC khi ghi bất cứ thứ gì — hỏng thì báo ngay tại chỗ nhập. */
export function validateServiceAccountJson(text) {
  let obj;
  try {
    obj = JSON.parse(text);
  } catch {
    throw new Error('Không phải JSON hợp lệ. Cần nguyên nội dung file key tải từ GCP.');
  }
  if (obj.type !== 'service_account') {
    throw new Error(`type="${obj.type}" — cần file key service account (type="service_account").`);
  }
  if (!obj.client_email) throw new Error('JSON thiếu client_email.');
  if (!obj.private_key) throw new Error('JSON thiếu private_key.');

  const privateKey = String(obj.private_key).replace(/\\n/g, '\n');
  try {
    createPrivateKey(privateKey);
  } catch (err) {
    throw new Error(`private_key không đọc được (${err.message}) — có thể bị cắt lúc sao chép.`);
  }
  return { clientEmail: obj.client_email, privateKey, projectId: obj.project_id ?? null };
}

/**
 * @param {object} flags  --sa-json <path> | --adc | --mode readonly|readwrite | --yes | --no-test
 */
export async function runInit(
  flags = {},
  { home = homedir(), log = console.log, env = process.env } = {},
) {
  const interactive = process.stdin.isTTY && !flags.yes;
  const rl = interactive ? createInterface({ input: process.stdin, output: process.stdout }) : null;
  const ask = async (q, fallback = '') => (rl ? (await rl.question(q)).trim() : fallback);

  try {
    log('\n📁 gdrive — cấu hình truy cập Google Drive\n');

    const existing = readConfig(home, env);
    let credentials = null;
    let useAdc = false;

    if (flags['sa-json']) {
      credentials = validateServiceAccountJson(
        readFileSync(String(flags['sa-json']).replace(/^~/, home), 'utf8'),
      );
    } else if (flags.adc) {
      useAdc = true;
    } else if (!interactive && existing?.clientEmail) {
      credentials = { clientEmail: existing.clientEmail, privateKey: existing.privateKey };
    } else if (interactive) {
      if (existing?.clientEmail) {
        log(`Đang có cấu hình cho: ${existing.clientEmail}`);
        if (!/^n/i.test(await ask('Giữ nguyên? [Y/n] '))) {
          credentials = { clientEmail: existing.clientEmail, privateKey: existing.privateKey };
        }
      }
      while (!credentials && !useAdc) {
        log('\n  [1] Đường dẫn tới file JSON key');
        log('  [2] Hướng dẫn tôi tạo service account');
        log('  [3] Dùng gcloud login sẵn có (ADC)');
        const choice = await ask('\nChọn [1/2/3]: ');
        if (choice === '2') {
          log(GCP_GUIDE);
          await ask('Tải file JSON xong thì Enter... ');
          continue;
        }
        if (choice === '3') {
          useAdc = true;
          log(
            '\n⚠️  Hai điều bắt buộc với ADC, thiếu là 403:\n' +
              '   • Grant mặc định KHÔNG có Drive/Sheets:\n' +
              '       gcloud auth application-default login \\\n' +
              '         --scopes=https://www.googleapis.com/auth/drive,https://www.googleapis.com/auth/spreadsheets,https://www.googleapis.com/auth/cloud-platform\n' +
              '   • Cần quota project đã bật 2 API:\n' +
              '       gcloud auth application-default set-quota-project <PROJECT_ID>\n',
          );
          continue;
        }
        const path = await ask('Đường dẫn file .json: ');
        try {
          credentials = validateServiceAccountJson(readFileSync(path.replace(/^~/, home), 'utf8'));
          log(`\n✅ Key hợp lệ — service account: ${credentials.clientEmail}`);
        } catch (err) {
          log(`\n❌ ${err.message}\n`);
        }
      }
    }

    if (!credentials && !useAdc) {
      log('❌ Chưa có credential. Dùng: gdrive init --sa-json <đường-dẫn-file.json>');
      return false;
    }

    const mode = (flags.mode ?? existing?.mode) === 'readwrite' ? 'readwrite' : 'readonly';
    const cfgFile = writeConfig({ mode, useAdc, ...(credentials ?? {}) }, home, env);
    if (process.platform === 'win32') {
      log(`✅ Đã ghi cấu hình → ${cfgFile}`);
      log('⚠️  Windows không set được chmod 600 cho file chứa private key.');
      log(`   Siết ACL: icacls "${cfgFile}" /inheritance:r /grant:r "%USERNAME%:F"`);
    } else {
      log(`✅ Đã ghi cấu hình → ${cfgFile} (chmod 600)`);
    }
    log(`   Chế độ: ${mode}${mode === 'readonly' ? ' — tool ghi bị ẩn khỏi Claude' : ''}`);

    if (!flags['no-test']) {
      log('\n🔎 Kiểm tra kết nối...');
      try {
        const client = createClient({ credentials, mode, home, env, retries: 2 });
        const info = await about(client);
        const email = info.user?.emailAddress ?? '(không rõ)';
        log(`✅ Kết nối OK — danh tính: ${email}`);
        log('\n📋 Share file/thư mục cho email này thì mới truy cập được:\n');
        log(`      ${email}\n`);
        if (Number(info.storageQuota?.limit ?? 0) === 0 && credentials) {
          log(
            '⚠️  Service account có 0 byte dung lượng My Drive — BÌNH THƯỜNG.\n' +
              '   Hệ quả: upload chỉ chạy vào Shared Drive. Đọc thì không ảnh hưởng.',
          );
        }
      } catch (err) {
        log(`⚠️  Chưa kết nối được: ${err.message.split('\n')[0]}`);
        log('   Cấu hình vẫn được lưu — chạy `gdrive status` để chẩn đoán.');
      }
    }

    if (hasLegacyInstall(home)) {
      log(
        '\n⚠️  Còn dấu vết bản cài npx cũ (~/.claude/gdrive*, ~/.claude/skills/gdrive).\n' +
          '   Dọn bằng: gdrive uninstall --purge',
      );
    }

    log(`\nXong. Dữ liệu plugin: ${pluginDataDir(env, home)}`);
    log('MCP server sẽ phát hiện cấu hình mới ở request kế tiếp; nếu client không refresh tool list thì mở session mới.\n');
    return true;
  } finally {
    rl?.close();
  }
}
