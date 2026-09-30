// Doctor: kiểm từng mắt xích, chỉ ra mắt nào hỏng và sửa thế nào.

import { existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';

import { findRegistrations } from './clients.mjs';
import { about } from './drive.mjs';
import { createClient } from './client.mjs';
import {
  configPath,
  foreignPluginDataDir,
  hasLegacyInstall,
  listConfigFiles,
  neutralConfigDir,
  pluginDataDir,
  readConfigWithSource,
} from './config.mjs';
import { resolveCredentials, scopesForMode } from './credentials.mjs';

const OK = '✅';
const WARN = '⚠️ ';
const BAD = '❌';
const MIN_NODE = { major: 18, minor: 17, patch: 0 };

function parseNodeVersion(version) {
  const [, major = '0', minor = '0', patch = '0'] = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(version)) ?? [];
  return { major: Number(major), minor: Number(minor), patch: Number(patch) };
}

function nodeOk(version) {
  const got = parseNodeVersion(version);
  return (
    got.major > MIN_NODE.major ||
    (got.major === MIN_NODE.major && got.minor > MIN_NODE.minor) ||
    (got.major === MIN_NODE.major && got.minor === MIN_NODE.minor && got.patch >= MIN_NODE.patch)
  );
}

export async function runStatus({
  home = homedir(),
  log = console.log,
  env = process.env,
  platform = process.platform,
  version = process.version,
  cwd = process.cwd(),
} = {}) {
  let healthy = true;
  const fail = () => {
    healthy = false;
  };

  log('\n📁 gdrive — kiểm tra sức khoẻ\n');

  if (nodeOk(version)) {
    log(`${OK} Node.js: ${version}`);
  } else {
    log(`${BAD} Node.js: ${version} — cần Node >= 18.17 để MCP server chạy được.`);
    log('     Sửa: nâng Node rồi khởi động lại client AI (Claude Code, Codex, Cursor…) và terminal.');
    fail();
  }

  // 1. Cấu hình
  const cfgFile = configPath(env, home);
  const cfgWithSource = readConfigWithSource(home, env);
  const cfg = cfgWithSource?.config ?? null;
  if (!cfg) {
    log(`${WARN} Chưa có cấu hình ở ${cfgFile}`);
    log('     Chạy: gdrive init --sa-json <đường-dẫn-key.json>   (trong Claude Code: /gdrive-setup)');
    log(`     (vẫn dùng được nếu credential nằm trong biến môi trường)`);
  } else {
    const activeConfigFile = cfgWithSource.path;
    log(`${OK} Cấu hình: ${activeConfigFile}`);
    if (platform === 'win32') {
      log(`${WARN} Windows không set được chmod 600 cho file chứa private key.`);
      log(`     Siết ACL: icacls "${activeConfigFile}" /inheritance:r /grant:r "%USERNAME%:F"`);
    } else if (existsSync(activeConfigFile)) {
      const mode = statSync(activeConfigFile).mode & 0o777;
      if (mode === 0o600) log(`${OK} Quyền file: 600`);
      else {
        log(`${BAD} Quyền file là ${mode.toString(8)}, phải là 600 — file chứa private key.`);
        log(`     Sửa: chmod 600 ${activeConfigFile}`);
        fail();
      }
    }
    log(`${OK} Chế độ: ${cfg.mode ?? 'readonly'}`);
  }
  log(`${OK} Thư mục config chung: ${neutralConfigDir(env, home, platform)}`);
  const foreign = foreignPluginDataDir(env);
  if (foreign) {
    log(`${WARN} Bỏ qua CLAUDE_PLUGIN_DATA=${foreign} — thư mục của plugin khác, không phải gdrive.`);
  } else if (env.CLAUDE_PLUGIN_DATA) {
    log(`${OK} Thư mục data plugin Claude: ${pluginDataDir(env, home)}`);
  }

  // 1b. Client AI khác đã đăng ký MCP server chưa (plugin Claude tự lo, không liệt kê).
  const registrations = findRegistrations({ home, env, platform, cwd });
  if (registrations.length) {
    log(`${OK} Đã đăng ký cho: ${registrations.map((r) => `${r.label}${r.project ? ' (project)' : ''}`).join(', ')}`);
    for (const r of registrations.filter((x) => x.missing.length)) {
      log(`${BAD} ${r.label}: entry trỏ tới đường dẫn không còn tồn tại (${r.missing.join(', ')}).`);
      log(`     Sửa: gdrive install --client ${r.id}${r.project ? ' --project' : ''}`);
      fail();
    }
    const active = cfgWithSource?.path;
    if (active && /[\\/]\.claude[\\/]plugins[\\/]data[\\/]/.test(active)) {
      log(`${WARN} Credential các client trên đang dùng nằm trong thư mục data plugin Claude —`);
      log('     gỡ plugin Claude thì mất theo; khi đó chạy lại: gdrive init --sa-json <đường-dẫn-key.json>');
    }
  }

  // 2. Credential
  let credentials;
  try {
    credentials = resolveCredentials({ env, home });
    const who = credentials.clientEmail ?? credentials.clientId ?? '(token trần)';
    log(`${OK} Credential: ${credentials.type} từ ${credentials.source} — ${who}`);
  } catch (err) {
    log(`${BAD} Không tìm thấy credential.`);
    log(err.message.split('\n').map((l) => `     ${l}`).join('\n'));
    fail();
  }

  // 3. Tàn dư bản cài cũ
  if (hasLegacyInstall(home)) {
    log(`${WARN} Còn dấu vết bản cài npx cũ — dọn bằng: gdrive uninstall --purge`);
  }

  const pluginConfigFiles = listConfigFiles(home, env);
  if (pluginConfigFiles.length > 1) {
    const active = cfgWithSource?.path;
    log(`${WARN} Có ${pluginConfigFiles.length} file config chứa private key trên đĩa.`);
    for (const file of pluginConfigFiles) {
      log(`     ${file === active ? 'ĐANG dùng' : 'bản thừa'}: ${file}`);
    }
    log('     Dọn bản thừa: gdrive uninstall --purge (sau đó thu hồi/xoay key trong GCP nếu key đã lộ).');
  }

  // 4. Gọi thật
  if (credentials) {
    const mode = cfg?.mode ?? 'readonly';
    log(`\n🔎 Gọi thử Drive API (scope ${mode})...`);
    try {
      const client = createClient({ mode, home, env, retries: 2 });
      const info = await about(client);
      const email = info.user?.emailAddress ?? '(không rõ)';
      log(`${OK} Token OK — danh tính: ${email}`);
      if (credentials.type === 'service_account') {
        log(`     Scope: ${scopesForMode(mode).join(' ')}`);
      } else {
        log(`${WARN} Với ADC/token gcloud, readonly KHÔNG giới hạn scope thật — token mang đủ quyền đã được cấp cho tài khoản đó; giới hạn duy nhất là các tool ghi bị ẩn.`);
        log(`     Scope theo mode: ${scopesForMode(mode).join(' ')} (không thu hẹp token ADC/gcloud)`);
      }
      log(`\n     Share file/thư mục cho email này thì mới đọc/ghi được:\n       ${email}`);
      if (Number(info.storageQuota?.limit ?? 0) === 0 && credentials.type === 'service_account') {
        log(`\n${WARN} Dung lượng My Drive = 0 (bình thường với service account).`);
        log('     Upload chỉ chạy vào Shared Drive; My Drive sẽ 403 storageQuotaExceeded.');
      }
    } catch (err) {
      const first = err.message.split('\n')[0];
      log(`${BAD} Gọi API thất bại: ${first}`);
      if (/SERVICE_DISABLED|has not been used/i.test(err.message)) {
        log('     → Chưa bật API. Bật CẢ HAI:');
        log('       https://console.cloud.google.com/apis/library/drive.googleapis.com');
        log('       https://console.cloud.google.com/apis/library/sheets.googleapis.com');
      } else if (Number(err.code) === 401) {
        log('     → Token bị từ chối: key đã bị xoá trong GCP, hoặc đồng hồ máy lệch >5 phút.');
      }
      fail();
    }
  }

  log(healthy ? `\n${OK} Mọi thứ ổn.\n` : `\n${BAD} Có mục cần xử lý ở trên.\n`);
  return healthy;
}
