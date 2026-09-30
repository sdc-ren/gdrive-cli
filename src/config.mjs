// Đọc/ghi config (chứa private key → chmod 600 trên Unix).
//
// Thứ tự ĐỌC:
//   1. `$GDRIVE_CONFIG_DIR` — người dùng chỉ định rõ, thắng mọi thứ.
//   2. Thư mục data của plugin Claude Code — `$CLAUDE_PLUGIN_DATA` (chỉ khi là của plugin
//      này, xem ownPluginDataDir), hoặc dò `gdrive*`.
//      Sống qua update, tự xoá khi gỡ plugin.
//   3. Thư mục trung lập (`~/.config/gdrive-cli`, `%APPDATA%\gdrive-cli`) — cho Codex,
//      Copilot, Cursor, Kiro… và máy không cài plugin Claude.
//   4. `~/.claude/gdrive.json` — vị trí CŨ của bản cài bằng npx. Chỉ ĐỌC.
//
// Máy có cả plugin Claude lẫn client khác thì mọi bên dùng CHUNG một file: chỉ ghi mới
// vào thư mục trung lập khi chưa có file nào đang được đọc.

import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, normalize } from 'node:path';

/** Id mặc định khi phải tự đoán: tên plugin + marketplace, ký tự lạ → '-'. */
const PLUGIN_DATA_ID = 'gdrive-gdrive-cli';

const dataRoot = (home) => join(home, '.claude', 'plugins', 'data');

/**
 * Thư mục data của plugin.
 *
 * ⚠️ TÊN THƯ MỤC KHÔNG ĐOÁN ĐƯỢC. Đo thực tế 2026-07-28: MCP server nhận
 * `CLAUDE_PLUGIN_DATA=…/data/gdrive-inline`, trong khi CLI chạy ngoài Claude Code (không có
 * biến này) tính ra `…/data/gdrive-gdrive-cli` theo mẫu tài liệu. Hai bên ghi/đọc lệch nhau
 * ⇒ tool báo "không tìm thấy credential" dù `gdrive status` xanh.
 *
 * Nên: có biến (của CHÍNH plugin này) thì tin biến; không có thì DÒ mọi thư mục `gdrive*`
 * thay vì đoán một cái.
 */
export function pluginDataDir(env = process.env, home = homedir()) {
  const own = ownPluginDataDir(env);
  if (own) return own;
  const existing = candidateDataDirs(home).find((d) => existsSync(join(d, 'config.json')));
  return existing ?? join(dataRoot(home), PLUGIN_DATA_ID);
}

/**
 * `$CLAUDE_PLUGIN_DATA` chỉ khi nó thuộc plugin NÀY, không thì null.
 *
 * ⚠️ Đo thực tế 2026-09-30: shell trong Claude Code có thể mang `CLAUDE_PLUGIN_DATA` của
 * plugin KHÁC (…/data/codex-openai-codex). Tin mù thì `gdrive init` ghi private key vào thư
 * mục plugin lạ, còn MCP server của gdrive không bao giờ đọc tới. Plugin tên `gdrive` nên
 * thư mục data luôn bắt đầu bằng `gdrive` (đã gặp: gdrive-inline, gdrive-gdrive-cli).
 */
export function ownPluginDataDir(env = process.env) {
  const dir = env.CLAUDE_PLUGIN_DATA;
  return dir && basename(normalize(dir)).startsWith('gdrive') ? dir : null;
}

/** Có `$CLAUDE_PLUGIN_DATA` nhưng là của plugin khác — status dùng để cảnh báo. */
export function foreignPluginDataDir(env = process.env) {
  return env.CLAUDE_PLUGIN_DATA && !ownPluginDataDir(env) ? env.CLAUDE_PLUGIN_DATA : null;
}

/** Mọi thư mục data có thể là của plugin này, thư mục mặc định đứng trước. */
function candidateDataDirs(home) {
  const root = dataRoot(home);
  const preferred = join(root, PLUGIN_DATA_ID);
  let others = [];
  try {
    others = readdirSync(root)
      .filter((n) => n.startsWith('gdrive'))
      .map((n) => join(root, n))
      .filter((d) => d !== preferred);
  } catch {
    /* chưa có thư mục data nào */
  }
  return [preferred, ...others];
}

export function pluginConfigPath(env = process.env, home = homedir()) {
  return join(pluginDataDir(env, home), 'config.json');
}

/** Plugin Claude đã tạo thư mục data chưa — tức máy này có dùng plugin. */
function hasPluginDataDir(home) {
  return candidateDataDirs(home).some((d) => existsSync(d));
}

/**
 * Thư mục config không gắn với client AI nào.
 * XDG_CONFIG_HOME tương đối thì bỏ qua (theo spec XDG); Windows thiếu APPDATA thì tự tính.
 */
export function neutralConfigDir(env = process.env, home = homedir(), platform = process.platform) {
  if (env.GDRIVE_CONFIG_DIR) return env.GDRIVE_CONFIG_DIR;
  if (platform === 'win32') return join(env.APPDATA || join(home, 'AppData', 'Roaming'), 'gdrive-cli');
  const xdg = env.XDG_CONFIG_HOME;
  return join(xdg && isAbsolute(xdg) ? xdg : join(home, '.config'), 'gdrive-cli');
}

/** Vị trí cũ do bản cài npx (≤ v0.1) để lại — chỉ đọc. */
export function legacyConfigPath(home = homedir()) {
  return join(home, '.claude', 'gdrive.json');
}

/** Nơi `writeConfig` sẽ ghi. */
export function configPath(env = process.env, home = homedir()) {
  return writeTargetPath(home, env);
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function dedupePaths(paths) {
  const seen = new Set();
  return paths.filter((path) => {
    const key = normalize(path);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Mọi file config do gdrive-cli quản lý (trừ legacy), đúng thứ tự đọc. */
function ownedConfigSearchPaths(home, env) {
  return dedupePaths([
    ...(env.GDRIVE_CONFIG_DIR ? [join(env.GDRIVE_CONFIG_DIR, 'config.json')] : []),
    ...(ownPluginDataDir(env) ? [join(ownPluginDataDir(env), 'config.json')] : []),
    ...candidateDataDirs(home).map((dir) => join(dir, 'config.json')),
    join(neutralConfigDir({ ...env, GDRIVE_CONFIG_DIR: '' }, home), 'config.json'),
  ]);
}

/** Danh sách đường dẫn config theo đúng thứ tự đọc: GDRIVE_CONFIG_DIR → plugin → trung lập → legacy. */
export function configSearchPaths(home = homedir(), env = process.env) {
  return dedupePaths([...ownedConfigSearchPaths(home, env), legacyConfigPath(home)]);
}

/**
 * Đọc config kèm đường dẫn thật đã dùng. Dò LẦN LƯỢT theo configSearchPaths — tên thư mục
 * data plugin không đoán được (xem pluginDataDir).
 */
export function readConfigWithSource(home = homedir(), env = process.env) {
  for (const path of configSearchPaths(home, env)) {
    const config = readJson(path);
    if (config) return { config, path };
  }
  return null;
}

export function readConfig(home = homedir(), env = process.env) {
  return readConfigWithSource(home, env)?.config ?? null;
}

/** Các file config đang có trên đĩa — mỗi file là một bản private key. */
export function listConfigFiles(home = homedir(), env = process.env) {
  const files = [];
  for (const file of ownedConfigSearchPaths(home, env)) {
    if (existsSync(file)) files.push(file);
  }
  return files;
}

function samePath(a, b) {
  return normalize(a) === normalize(b);
}

function isOwnedConfigFile(file, home, env) {
  return ownedConfigSearchPaths(home, env).some((path) => samePath(file, path));
}

function writeTargetPath(home, env) {
  if (env.GDRIVE_CONFIG_DIR) return join(env.GDRIVE_CONFIG_DIR, 'config.json');
  const active = readConfigWithSource(home, env)?.path;
  if (active && isOwnedConfigFile(active, home, env)) return active;
  if (ownPluginDataDir(env)) return join(ownPluginDataDir(env), 'config.json');
  if (hasPluginDataDir(home)) return join(dataRoot(home), PLUGIN_DATA_ID, 'config.json');
  return join(neutralConfigDir(env, home), 'config.json');
}

/**
 * Ghi đúng một file: GDRIVE_CONFIG_DIR → file đang được đọc → CLAUDE_PLUGIN_DATA →
 * thư mục plugin (nếu máy có plugin) → thư mục trung lập.
 * Private key không được nhân bản sang nhiều thư mục; cảnh báo/dọn bản thừa là việc của status/uninstall.
 */
export function writeConfig(cfg, home = homedir(), env = process.env) {
  const file = writeTargetPath(home, env);
  const body = `${JSON.stringify(cfg, null, 2)}\n`;
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, body);
  if (process.platform !== 'win32') chmodSync(file, 0o600);
  return file;
}

/** Bản cài cũ còn sót không — dùng để nhắc người dùng dọn. */
export function hasLegacyInstall(home = homedir()) {
  return (
    existsSync(legacyConfigPath(home)) ||
    existsSync(join(home, '.claude', 'gdrive')) ||
    existsSync(join(home, '.claude', 'skills', 'gdrive'))
  );
}
