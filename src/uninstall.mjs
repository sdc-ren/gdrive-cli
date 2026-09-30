// Dọn bản cài KIỂU CŨ (npx wizard, ≤ v0.1).
//
// Từ v0.2 việc gỡ plugin do Claude Code lo: `claude plugin uninstall gdrive@gdrive-cli`
// (nó xoá luôn thư mục data). File này chỉ còn để dọn tàn dư của cách cài cũ — 4 chỗ rải
// rác dưới ~/.claude mà cơ chế plugin không biết tới.

import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { legacyConfigPath, listPluginConfigFiles } from './config.mjs';

const RULE_MARKER = 'gdrive/bin/cli.mjs';

export function runUninstall(flags = {}, { home = homedir(), log = console.log, env = process.env } = {}) {
  let found = false;

  for (const [dir, label] of [
    [join(home, '.claude', 'gdrive'), 'code'],
    [join(home, '.claude', 'skills', 'gdrive'), 'skill'],
  ]) {
    if (existsSync(dir)) {
      rmSync(dir, { recursive: true, force: true });
      log(`✅ Đã xoá ${label}: ${dir}`);
      found = true;
    }
  }

  // Allow-rule bản cũ thêm vào settings.json — plugin không cần nữa.
  const settingsFile = join(home, '.claude', 'settings.json');
  if (existsSync(settingsFile)) {
    try {
      const settings = JSON.parse(readFileSync(settingsFile, 'utf8'));
      const allow = settings.permissions?.allow;
      if (Array.isArray(allow)) {
        const kept = allow.filter((r) => !(typeof r === 'string' && r.includes(RULE_MARKER)));
        if (kept.length !== allow.length) {
          settings.permissions.allow = kept;
          if (kept.length === 0) delete settings.permissions.allow;
          if (Object.keys(settings.permissions).length === 0) delete settings.permissions;
          writeFileSync(settingsFile, `${JSON.stringify(settings, null, 2)}\n`);
          log('✅ Đã gỡ allow-rule khỏi settings.json');
          found = true;
        }
      }
    } catch {
      // JSON hỏng: KHÔNG đụng vào. Ghi đè ở đây là phá settings của người dùng.
      log(`⚠️  ${settingsFile} không parse được — nếu còn allow-rule thì gỡ tay.`);
    }
  }

  const cfgFile = legacyConfigPath(home);
  if (existsSync(cfgFile)) {
    if (flags.purge) {
      rmSync(cfgFile, { force: true });
      log(`✅ Đã xoá config cũ ${cfgFile}`);
    } else {
      log(`ℹ️  Giữ lại ${cfgFile} (còn private key). Xoá luôn: thêm --purge`);
    }
    found = true;
  }

  const pluginConfigFiles = listPluginConfigFiles(home, env);
  if (pluginConfigFiles.length > 0) {
    if (flags.purge) {
      for (const file of pluginConfigFiles) {
        rmSync(file, { force: true });
        log(`✅ Đã xoá config plugin ${file}`);
      }
      log('⚠️  Xoá file không thu hồi được key đã lộ. Biện pháp thật là thu hồi/xoay key trong GCP Console.');
    } else {
      log('ℹ️  Giữ lại config plugin sau (mỗi file chứa một private key trên đĩa):');
      for (const file of pluginConfigFiles) log(`   - ${file}`);
      log('   Xoá luôn: thêm --purge');
    }
    found = true;
  }

  if (!found) log('Không thấy tàn dư bản cài cũ nào.');
  log('\nGỡ plugin: claude plugin uninstall gdrive@gdrive-cli\n');
  return true;
}
