// Đọc/ghi config (chứa private key → chmod 600 trên Unix).
//
// Có HAI vị trí, theo thứ tự ưu tiên:
//   1. Thư mục data của plugin — `$CLAUDE_PLUGIN_DATA`, hoặc tính ra nếu biến vắng.
//      Đây là vị trí CHUẨN từ v0.2: sống qua update, tự xoá khi gỡ plugin.
//   2. `~/.claude/gdrive.json` — vị trí CŨ của bản cài bằng npx. Chỉ ĐỌC, để người đã
//      cài kiểu cũ không mất cấu hình; không ghi mới vào đây nữa.

import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, normalize } from 'node:path';

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
 * Nên: có biến thì tin biến; không có thì DÒ mọi thư mục `gdrive*` thay vì đoán một cái.
 */
export function pluginDataDir(env = process.env, home = homedir()) {
  if (env.CLAUDE_PLUGIN_DATA) return env.CLAUDE_PLUGIN_DATA;
  const existing = candidateDataDirs(home).find((d) => existsSync(join(d, 'config.json')));
  return existing ?? join(dataRoot(home), PLUGIN_DATA_ID);
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

/** Vị trí cũ do bản cài npx (≤ v0.1) để lại — chỉ đọc. */
export function legacyConfigPath(home = homedir()) {
  return join(home, '.claude', 'gdrive.json');
}

/** Nơi ghi config mới. */
export function configPath(env = process.env, home = homedir()) {
  return pluginConfigPath(env, home);
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

function pluginConfigSearchPaths(home, env) {
  return dedupePaths([
    ...(env.CLAUDE_PLUGIN_DATA ? [join(env.CLAUDE_PLUGIN_DATA, 'config.json')] : []),
    ...candidateDataDirs(home).map((dir) => join(dir, 'config.json')),
  ]);
}

/** Danh sách đường dẫn config theo đúng thứ tự đọc: env → data `gdrive*` → legacy. */
export function configSearchPaths(home = homedir(), env = process.env) {
  return dedupePaths([...pluginConfigSearchPaths(home, env), legacyConfigPath(home)]);
}

/**
 * Đọc config kèm đường dẫn thật đã dùng. Dò LẦN LƯỢT vì tên thư mục data không đoán được (xem pluginDataDir):
 * thư mục do env chỉ định → mọi thư mục `gdrive*` → vị trí cũ của bản cài npx.
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

export function listPluginConfigFiles(home = homedir(), env = process.env) {
  const files = [];
  for (const file of pluginConfigSearchPaths(home, env)) {
    if (existsSync(file)) files.push(file);
  }
  return files;
}

function samePath(a, b) {
  return normalize(a) === normalize(b);
}

function isPluginConfigFile(file, home, env) {
  return pluginConfigSearchPaths(home, env).some((path) => samePath(file, path));
}

function writeTargetPath(home, env) {
  const active = readConfigWithSource(home, env)?.path;
  if (active && isPluginConfigFile(active, home, env)) return active;
  if (env.CLAUDE_PLUGIN_DATA) return join(env.CLAUDE_PLUGIN_DATA, 'config.json');
  return join(dataRoot(home), PLUGIN_DATA_ID, 'config.json');
}

/**
 * Ghi đúng một file: file plugin đang được đọc → env chỉ định → thư mục mặc định.
 * Private key không được nhân bản sang nhiều thư mục; cảnh báo/dọn bản thừa là việc của status/uninstall.
 */
export function writeConfig(cfg, home = homedir(), env = process.env) {
  const file = writeTargetPath(home, env);
  const body = `${JSON.stringify(cfg, null, 2)}\n`;
  mkdirSync(dirname(file), { recursive: true });
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
