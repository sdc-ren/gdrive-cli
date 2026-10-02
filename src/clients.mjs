// Đăng ký MCP server gdrive vào client AI: Claude Code, Claude Desktop, Codex, Copilot (VS Code
// + CLI), Cursor, Kiro. Plugin Claude Code là cách cài khác, không cần bước này.
//
// Claude Code cấp user lưu MCP trong ~/.claude.json, file mà Claude Code đang chạy cũng ghi
// vào. Vì vậy ta không sửa file đó mà gọi `claude mcp add/remove`; chỉ ĐỌC nó để biết đã đăng ký
// chưa. Không có lệnh `claude` thì in lệnh để người dùng tự chạy.
//
// Nguyên tắc: chỉ MERGE đúng khoá `gdrive`, không bao giờ ghi đè cả file của người dùng;
// file không đọc chắc được (JSONC, TOML mơ hồ) thì KHÔNG đụng vào, in đoạn cấu hình để tự
// dán. Không bao giờ ghi credential vào config của client — server tự đọc config gdrive.

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PKG_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SERVER_NAME = 'gdrive';
const SKILL_SOURCE = join(PKG_ROOT, 'skills', 'gdrive', 'SKILL.md');

function vscodeUserDir(home, env, platform) {
  if (platform === 'darwin') return join(home, 'Library', 'Application Support', 'Code', 'User');
  if (platform === 'win32') return join(env.APPDATA || join(home, 'AppData', 'Roaming'), 'Code', 'User');
  const xdg = env.XDG_CONFIG_HOME;
  return join(xdg && isAbsolute(xdg) ? xdg : join(home, '.config'), 'Code', 'User');
}

function claudeDesktopDir(home, env, platform) {
  if (platform === 'darwin') return join(home, 'Library', 'Application Support', 'Claude');
  if (platform === 'win32') return join(env.APPDATA || join(home, 'AppData', 'Roaming'), 'Claude');
  // Linux không có bản chính thức; các bản build cộng đồng đọc ở đây.
  const xdg = env.XDG_CONFIG_HOME;
  return join(xdg && isAbsolute(xdg) ? xdg : join(home, '.config'), 'Claude');
}

/**
 * Mỗi client: file MCP cấp user/project, định dạng, khoá chứa danh sách server, trường
 * bắt buộc thêm vào entry, và thư mục Agent Skill (chuẩn SKILL.md).
 */
export const CLIENTS = {
  claude: {
    label: 'Claude Code',
    format: 'json',
    key: 'mcpServers',
    // Chỉ đọc; ghi qua `claude mcp add --scope user` (xem đầu file).
    user: ({ home }) => join(home, '.claude.json'),
    userViaCli: true,
    project: ({ cwd }) => join(cwd, '.mcp.json'),
    skill: { user: ({ home }) => join(home, '.claude', 'skills'), project: ({ cwd }) => join(cwd, '.claude', 'skills') },
    notes: {
      project: 'Claude Code hỏi xác nhận trước khi dùng server trong .mcp.json của project.',
    },
  },
  'claude-desktop': {
    label: 'Claude Desktop',
    format: 'json',
    key: 'mcpServers',
    user: ({ home, env, platform }) => join(claudeDesktopDir(home, env, platform), 'claude_desktop_config.json'),
    project: null,
    skill: null,
  },
  codex: {
    label: 'Codex',
    format: 'toml',
    user: ({ home }) => join(home, '.codex', 'config.toml'),
    project: ({ cwd }) => join(cwd, '.codex', 'config.toml'),
    skill: { user: ({ home }) => join(home, '.agents', 'skills'), project: ({ cwd }) => join(cwd, '.agents', 'skills') },
    notes: {
      project: 'Codex chỉ đọc .codex/config.toml của project đã được trust.',
    },
  },
  copilot: {
    label: 'GitHub Copilot (VS Code)',
    format: 'json',
    key: 'servers',
    extra: { type: 'stdio' },
    user: ({ home, env, platform }) => join(vscodeUserDir(home, env, platform), 'mcp.json'),
    project: ({ cwd }) => join(cwd, '.vscode', 'mcp.json'),
    skill: { user: ({ home }) => join(home, '.agents', 'skills'), project: ({ cwd }) => join(cwd, '.agents', 'skills') },
    notes: {
      user: 'Ghi vào profile mặc định của VS Code. Dùng profile khác thì thêm bằng: code --add-mcp \'<json ở trên>\'.',
    },
  },
  'copilot-cli': {
    label: 'GitHub Copilot CLI',
    format: 'json',
    key: 'mcpServers',
    // Thiếu `tools` thì Copilot CLI không bật tool nào của server.
    extra: { type: 'local', tools: ['*'] },
    user: ({ home }) => join(home, '.copilot', 'mcp-config.json'),
    project: null,
    skill: { user: ({ home }) => join(home, '.agents', 'skills'), project: ({ cwd }) => join(cwd, '.agents', 'skills') },
  },
  cursor: {
    label: 'Cursor',
    format: 'json',
    key: 'mcpServers',
    user: ({ home }) => join(home, '.cursor', 'mcp.json'),
    project: ({ cwd }) => join(cwd, '.cursor', 'mcp.json'),
    skill: { user: ({ home }) => join(home, '.agents', 'skills'), project: ({ cwd }) => join(cwd, '.agents', 'skills') },
  },
  kiro: {
    label: 'Kiro',
    format: 'json',
    key: 'mcpServers',
    user: ({ home }) => join(home, '.kiro', 'settings', 'mcp.json'),
    project: ({ cwd }) => join(cwd, '.kiro', 'settings', 'mcp.json'),
    skill: { user: ({ home }) => join(home, '.kiro', 'skills'), project: ({ cwd }) => join(cwd, '.kiro', 'skills') },
  },
};

export const CLIENT_IDS = Object.keys(CLIENTS);

// ── Lệnh chạy server ─────────────────────────────────────────────────────────

/**
 * Đường dẫn TUYỆT ĐỐI tới node và server cho config cấp user: app GUI mở từ Dock thường
 * không có PATH của nvm/Homebrew nên `gdrive` trần không chạy được ở đó.
 */
export function resolveLaunch({ root = PKG_ROOT, execPath = process.execPath, platform = process.platform } = {}) {
  const serverPath = realpathSync(join(root, 'server', 'index.mjs'));
  if (/[\\/](_npx|_cacache)[\\/]/.test(serverPath)) {
    throw new Error(
      `gdrive đang chạy từ cache của npx (${serverPath}) — đường dẫn này bị dọn bất kỳ lúc nào.\n` +
        'Cài hẳn rồi chạy lại: npm i -g github:sdc-ren/gdrive-cli',
    );
  }
  let nodePath = execPath;
  // Homebrew: execPath là bản thật trong Cellar/<phiên bản>, `brew upgrade` xoá nó đi.
  // Symlink ổn định trỏ cùng file thì dùng symlink.
  if (platform !== 'win32') {
    for (const candidate of ['/opt/homebrew/bin/node', '/usr/local/bin/node']) {
      try {
        if (realpathSync(candidate) === realpathSync(execPath)) {
          nodePath = candidate;
          break;
        }
      } catch {
        /* không có symlink này */
      }
    }
  }
  return { nodePath, serverPath };
}

/**
 * Entry của server. Cấp project KHÔNG chứa đường dẫn máy cá nhân (file sẽ được commit),
 * nên gọi `gdrive mcp` qua PATH.
 */
export function buildEntry(id, { project = false, launch } = {}) {
  const base = project
    ? { command: 'gdrive', args: ['mcp'] }
    : { command: launch.nodePath, args: [launch.serverPath] };
  return { ...(CLIENTS[id].extra ?? {}), ...base };
}

// ── JSON ─────────────────────────────────────────────────────────────────────

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function parseJsonFile(text) {
  if (text == null || !text.trim()) return { ok: true, obj: {} };
  try {
    const obj = JSON.parse(text);
    if (!isPlainObject(obj)) return { ok: false, reason: 'nội dung không phải một object JSON' };
    return { ok: true, obj };
  } catch {
    return { ok: false, reason: 'không parse được JSON (có comment/JSONC?)' };
  }
}

/** Gắn/thay đúng `obj[key][name]`; mọi thứ khác giữ nguyên. */
export function upsertJsonServer(text, key, name, entry) {
  const parsed = parseJsonFile(text);
  if (!parsed.ok) return parsed;
  const servers = parsed.obj[key] ?? {};
  if (!isPlainObject(servers)) return { ok: false, reason: `"${key}" không phải object` };
  if (same(servers[name], entry)) return { ok: true, changed: false, text };
  const obj = { ...parsed.obj, [key]: { ...servers, [name]: entry } };
  return { ok: true, changed: true, text: `${JSON.stringify(obj, null, 2)}\n` };
}

export function removeJsonServer(text, key, name) {
  if (text == null) return { ok: true, changed: false, text };
  const parsed = parseJsonFile(text);
  if (!parsed.ok) return parsed;
  const servers = parsed.obj[key];
  if (!isPlainObject(servers) || !(name in servers)) return { ok: true, changed: false, text };
  const { [name]: _removed, ...rest } = servers;
  return { ok: true, changed: true, text: `${JSON.stringify({ ...parsed.obj, [key]: rest }, null, 2)}\n` };
}

function readJsonServer(text, key, name) {
  const parsed = parseJsonFile(text);
  if (!parsed.ok) return null;
  const entry = parsed.obj[key]?.[name];
  return isPlainObject(entry) ? entry : null;
}

// ── TOML (chỉ đủ cho khối [mcp_servers.gdrive], không phải parser đầy đủ) ─────

/**
 * Literal string '…' để `\` trong đường dẫn Windows không bị hiểu là escape. Chỉ khi chuỗi
 * có dấu nháy đơn mới rơi về basic string có escape.
 */
export function tomlString(s) {
  if (!/['\r\n]/.test(s)) return `'${s}'`;
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r/g, '\\r').replace(/\n/g, '\\n')}"`;
}

function renderTomlBlock(name, entry, eol) {
  const lines = [`[mcp_servers.${name}]`];
  for (const [k, v] of Object.entries(entry)) {
    lines.push(`${k} = ${Array.isArray(v) ? `[${v.map(tomlString).join(', ')}]` : tomlString(String(v))}`);
  }
  return lines.join(eol);
}

const HEADER_RE = /^\s*(\[\[?)([^\]]*)\]\]?\s*(#.*)?$/;
const normName = (raw) => raw.replace(/\s+/g, '').replace(/["']/g, '');

/**
 * Tách file thành dòng giữ lại / dòng thuộc khối của ta. Gặp cách viết mơ hồ (dotted key,
 * inline table, header có nháy/khoảng trắng, chuỗi nhiều dòng) thì từ chối thay vì đoán.
 */
function splitToml(text, name) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  if (/'''|"""/.test(text)) return { ok: false, reason: 'file có chuỗi nhiều dòng — không sửa tự động được' };
  const ours = `mcp_servers.${name}`;
  const kept = [];
  let current = '';
  let inOurs = false;
  let found = false;
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    const header = HEADER_RE.exec(line);
    if (header && !trimmed.startsWith('#')) {
      const raw = header[2].trim();
      current = normName(raw);
      inOurs = current === ours || current.startsWith(`${ours}.`);
      if (inOurs && (header[1] === '[[' || raw !== current)) {
        return { ok: false, reason: `header [${raw}] viết theo kiểu khó sửa an toàn` };
      }
      if (inOurs) {
        found = true;
        continue;
      }
      kept.push(line);
      continue;
    }
    if (inOurs) continue;
    if (!trimmed.startsWith('#')) {
      if (current === '' && /^["']?mcp_servers["']?\s*[.=]/.test(trimmed)) {
        return { ok: false, reason: 'mcp_servers khai báo dạng dotted key/inline table' };
      }
      if (current === 'mcp_servers' && new RegExp(`^["']?${name}["']?\\s*[.=]`).test(trimmed)) {
        return { ok: false, reason: `server "${name}" khai báo dạng dotted key/inline table` };
      }
    }
    kept.push(line);
  }
  while (kept.length && !kept[kept.length - 1].trim()) kept.pop();
  return { ok: true, kept, eol, found };
}

export function upsertTomlServer(text, name, entry) {
  const split = splitToml(text ?? '', name);
  if (!split.ok) return split;
  const { kept, eol } = split;
  const block = renderTomlBlock(name, entry, eol);
  const next = `${kept.length ? `${kept.join(eol)}${eol}${eol}` : ''}${block}${eol}`;
  return { ok: true, changed: next !== text, text: next };
}

export function removeTomlServer(text, name) {
  if (text == null) return { ok: true, changed: false, text };
  const split = splitToml(text, name);
  if (!split.ok) return split;
  if (!split.found) return { ok: true, changed: false, text };
  const { kept, eol } = split;
  return { ok: true, changed: true, text: kept.length ? `${kept.join(eol)}${eol}` : '' };
}

function parseTomlValue(raw) {
  const v = raw.trim();
  if (v.startsWith("'")) return v.slice(1, v.indexOf("'", 1));
  if (v.startsWith('"')) {
    try {
      return JSON.parse(v.slice(0, v.lastIndexOf('"') + 1));
    } catch {
      return null;
    }
  }
  if (v.startsWith('[')) {
    const items = [];
    const re = /'([^']*)'|"((?:[^"\\]|\\.)*)"/g;
    let m;
    while ((m = re.exec(v))) items.push(m[1] ?? JSON.parse(`"${m[2]}"`));
    return items;
  }
  return null;
}

/** Đọc command/args trong khối của ta — đủ cho `status`, không phải parser TOML. */
export function readTomlServer(text, name) {
  const lines = String(text).split(/\r?\n/);
  const start = lines.findIndex((l) => l.trim() === `[mcp_servers.${name}]`);
  if (start < 0) return null;
  const entry = {};
  for (const line of lines.slice(start + 1)) {
    if (HEADER_RE.test(line)) break;
    const m = /^\s*([A-Za-z_]+)\s*=\s*(.+)$/.exec(line);
    if (m) entry[m[1]] = parseTomlValue(m[2]);
  }
  return entry;
}

// ── Cài / gỡ ────────────────────────────────────────────────────────────────

function readText(file) {
  try {
    return readFileSync(file, 'utf8');
  } catch (err) {
    if (err?.code === 'ENOENT') return null;
    throw err;
  }
}

function snippetFor(client, entry) {
  if (client.format === 'toml') return renderTomlBlock(SERVER_NAME, entry, '\n');
  return JSON.stringify({ [client.key]: { [SERVER_NAME]: entry } }, null, 2);
}

function targetFile(id, { project, cwd, home, env, platform }) {
  const client = CLIENTS[id];
  if (!client) throw new Error(`Không biết client "${id}". Hỗ trợ: ${CLIENT_IDS.join(', ')}.`);
  const locate = project ? client.project : client.user;
  if (!locate) throw new Error(`${client.label} không có config MCP cấp project — bỏ --project.`);
  return locate({ cwd, home, env, platform });
}

const SKILL_MARKER = /^---\s*\nname:\s*gdrive\s*\n/;

function skillFile(id, { project, cwd, home }) {
  const locate = CLIENTS[id].skill?.[project ? 'project' : 'user'];
  if (!locate) return null;
  return join(locate({ cwd, home }), 'gdrive', 'SKILL.md');
}

/**
 * Chép Agent Skill (SKILL.md) cho client. Chỉ ghi đè file do chính ta cài (frontmatter
 * `name: gdrive`); skill cùng tên của ai khác thì không đụng.
 */
function installSkill(id, ctx) {
  const file = skillFile(id, ctx);
  if (!file) return { ok: false, file: null, reason: `${CLIENTS[id].label} không dùng Agent Skill` };
  const current = readText(file);
  if (current != null && !SKILL_MARKER.test(current.replace(/\r\n/g, '\n'))) {
    return { ok: false, file, reason: 'đã có skill gdrive khác ở đó — không ghi đè' };
  }
  const body = readFileSync(SKILL_SOURCE, 'utf8');
  if (current === body) return { ok: true, changed: false, file };
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, body);
  return { ok: true, changed: true, file };
}

function uninstallSkill(id, ctx) {
  const file = skillFile(id, ctx);
  if (!file) return { ok: true, changed: false, file: null };
  const current = readText(file);
  if (current == null) return { ok: true, changed: false, file };
  if (!SKILL_MARKER.test(current.replace(/\r\n/g, '\n'))) {
    return { ok: false, file, reason: 'skill ở đó không phải do gdrive cài — không xoá' };
  }
  rmSync(file);
  if (readdirSync(dirname(file)).length === 0) rmdirSync(dirname(file));
  return { ok: true, changed: true, file };
}

// ── Claude Code cấp user: qua lệnh `claude mcp` ──────────────────────────────

/** Windows cần shell vì `claude` là file .cmd; khi đó tự bọc nháy từng tham số. */
function defaultRunCommand(cmd, args, platform) {
  const win = platform === 'win32';
  const finalArgs = win ? args.map((a) => `"${String(a).replace(/"/g, '\\"')}"`) : args;
  return spawnSync(cmd, finalArgs, { encoding: 'utf8', shell: win });
}

const shellLine = (args) => ['claude', ...args].map((a) => (/[\s"']/.test(a) ? `"${a}"` : a)).join(' ');

function runClaude(ctx, args) {
  const run = ctx.runCommand ?? ((cmd, a) => defaultRunCommand(cmd, a, ctx.platform));
  const res = run('claude', args);
  if (!res?.error && res?.status === 0) return { ok: true };
  const reason = res?.error?.code === 'ENOENT'
    ? 'không tìm thấy lệnh claude'
    : `claude ${args.slice(0, 2).join(' ')} lỗi: ${String(res?.stderr || res?.error?.message || '').trim().split('\n')[0]}`;
  return { ok: false, reason, snippet: shellLine(args), snippetKind: 'command' };
}

function claudeUserEntry(file) {
  return readJsonServer(readText(file), 'mcpServers', SERVER_NAME);
}

function installClaudeUser(ctx, file, entry) {
  const current = claudeUserEntry(file);
  if (current && current.command === entry.command && same(current.args ?? [], entry.args)) {
    return { ok: true, changed: false };
  }
  const scope = ['--scope', 'user', SERVER_NAME];
  if (current) {
    const removed = runClaude(ctx, ['mcp', 'remove', ...scope]);
    if (!removed.ok) return removed;
  }
  const added = runClaude(ctx, ['mcp', 'add', ...scope, '--', entry.command, ...entry.args]);
  return added.ok ? { ok: true, changed: true } : added;
}

function uninstallClaudeUser(ctx, file) {
  if (!claudeUserEntry(file)) return { ok: true, changed: false };
  const removed = runClaude(ctx, ['mcp', 'remove', '--scope', 'user', SERVER_NAME]);
  return removed.ok ? { ok: true, changed: true } : removed;
}

function withDefaults(opts) {
  return {
    project: false,
    cwd: process.cwd(),
    home: homedir(),
    env: process.env,
    platform: process.platform,
    skill: false,
    ...opts,
  };
}

/**
 * Đăng ký server cho một client. Trả `{ ok, changed, file, entry, snippet?, reason?, skill? }`;
 * ok=false nghĩa là KHÔNG ghi gì và người dùng cần tự dán `snippet`.
 */
export function installClient(id, opts = {}) {
  const ctx = withDefaults(opts);
  const file = targetFile(id, ctx);
  const client = CLIENTS[id];
  const entry = buildEntry(id, { project: ctx.project, launch: ctx.project ? null : ctx.launch ?? resolveLaunch() });
  if (client.userViaCli && !ctx.project) {
    const res = installClaudeUser(ctx, file, entry);
    const out = { id, label: client.label, file, entry, ...res };
    return res.ok ? { ...out, skill: ctx.skill ? installSkill(id, ctx) : null } : out;
  }
  const text = readText(file);
  const res = client.format === 'toml'
    ? upsertTomlServer(text, SERVER_NAME, entry)
    : upsertJsonServer(text, client.key, SERVER_NAME, entry);
  const out = { id, label: client.label, file, entry, note: client.notes?.[ctx.project ? 'project' : 'user'] };
  if (!res.ok) return { ...out, ok: false, reason: res.reason, snippet: snippetFor(client, entry) };
  if (res.changed) {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, res.text);
  }
  return { ...out, ok: true, changed: res.changed, skill: ctx.skill ? installSkill(id, ctx) : null };
}

export function uninstallClient(id, opts = {}) {
  const ctx = withDefaults(opts);
  const file = targetFile(id, ctx);
  const client = CLIENTS[id];
  const out = { id, label: client.label, file };
  const skill = uninstallSkill(id, ctx);
  if (client.userViaCli && !ctx.project) return { ...out, ...uninstallClaudeUser(ctx, file), skill };
  const text = readText(file);
  const res = client.format === 'toml'
    ? removeTomlServer(text, SERVER_NAME)
    : removeJsonServer(text, client.key, SERVER_NAME);
  if (!res.ok) return { ...out, ok: false, reason: res.reason, skill };
  if (res.changed) writeFileSync(file, res.text);
  return { ...out, ok: true, changed: res.changed, skill };
}

/** Client nào đã đăng ký gdrive (chỉ đọc) và đường dẫn trong entry còn tồn tại không. */
export function findRegistrations(opts = {}) {
  const ctx = withDefaults(opts);
  const found = [];
  for (const id of CLIENT_IDS) {
    for (const project of [false, true]) {
      if (project && !CLIENTS[id].project) continue;
      const file = targetFile(id, { ...ctx, project });
      const text = readText(file);
      if (text == null) continue;
      const client = CLIENTS[id];
      const entry = client.format === 'toml'
        ? readTomlServer(text, SERVER_NAME)
        : readJsonServer(text, client.key, SERVER_NAME);
      if (!entry) continue;
      const paths = [entry.command, ...(Array.isArray(entry.args) ? entry.args : [])];
      const missing = paths.filter((p) => typeof p === 'string' && isAbsolute(p) && !existsSync(p));
      found.push({ id, label: client.label, project, file, entry, missing });
    }
  }
  return found;
}

// ── Lệnh CLI ────────────────────────────────────────────────────────────────

function parseClientFlag(flags) {
  const ids = String(flags.client === true ? '' : flags.client ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (!ids.length) {
    const e = new Error(`Thiếu --client. Hỗ trợ: ${CLIENT_IDS.join(', ')} (nhiều client cách nhau bằng dấu phẩy).`);
    e.exitCode = 2;
    throw e;
  }
  for (const id of ids) {
    if (!CLIENTS[id]) {
      const e = new Error(`Không biết client "${id}". Hỗ trợ: ${CLIENT_IDS.join(', ')}.`);
      e.exitCode = 2;
      throw e;
    }
  }
  return ids;
}

/** `gdrive install --client <tên>[,<tên>…] [--project] [--skill]` */
export function runInstall(flags = {}, { log = console.log, hasConfig = true, ...opts } = {}) {
  const ids = parseClientFlag(flags);
  const project = Boolean(flags.project);
  const launch = project ? null : opts.launch ?? resolveLaunch();
  let allOk = true;
  for (const id of ids) {
    const res = installClient(id, { ...opts, project, skill: Boolean(flags.skill), launch });
    if (!res.ok && res.snippetKind === 'command') {
      allOk = false;
      log(`⚠️  ${res.label}: chưa đăng ký — ${res.reason}. Tự chạy:\n`);
      log(`     ${res.snippet}\n`);
      continue;
    }
    if (!res.ok) {
      allOk = false;
      log(`⚠️  ${res.label}: KHÔNG sửa ${res.file} — ${res.reason}.`);
      log('   Tự dán đoạn sau vào file đó:\n');
      log(res.snippet.split('\n').map((l) => `     ${l}`).join('\n'));
      log('');
      continue;
    }
    log(`✅ ${res.label}: ${res.changed ? 'đã đăng ký' : 'đã có sẵn, không đổi'} → ${res.file}`);
    if (res.note) log(`   ${res.note}`);
    if (res.skill) {
      if (res.skill.ok) log(`   Skill: ${res.skill.changed ? 'đã cài' : 'đã có sẵn'} → ${res.skill.file}`);
      else log(`⚠️  Skill: ${res.skill.reason} (${res.skill.file})`);
    }
  }
  if (project) log('\nConfig cấp project gọi `gdrive mcp` qua PATH — mọi người dùng repo cần cài gdrive-cli (-g).');
  if (!hasConfig) log('\n⚠️  Chưa có credential. Chạy: gdrive init --sa-json <đường-dẫn-key.json>');
  log('Khởi động lại client (hoặc mở session mới) để nạp MCP server.\n');
  return allOk;
}

/** `gdrive uninstall --client <tên>[,<tên>…] [--project]` — không đụng credential. */
export function runClientUninstall(flags = {}, { log = console.log, ...opts } = {}) {
  const ids = parseClientFlag(flags);
  const project = Boolean(flags.project);
  let allOk = true;
  for (const id of ids) {
    const res = uninstallClient(id, { ...opts, project });
    if (!res.ok && res.snippetKind === 'command') {
      allOk = false;
      log(`⚠️  ${res.label}: chưa gỡ — ${res.reason}. Tự chạy: ${res.snippet}`);
    } else if (!res.ok) {
      allOk = false;
      log(`⚠️  ${res.label}: KHÔNG sửa ${res.file} — ${res.reason}. Gỡ tay khoá "gdrive".`);
    } else {
      log(`✅ ${res.label}: ${res.changed ? 'đã gỡ' : 'không có đăng ký nào'} (${res.file})`);
    }
    if (res.skill?.changed) log(`   Đã gỡ skill: ${res.skill.file}`);
    else if (res.skill && !res.skill.ok) log(`⚠️  Skill: ${res.skill.reason} (${res.skill.file})`);
  }
  log('Credential giữ nguyên. Xoá hẳn: gdrive uninstall --purge\n');
  return allOk;
}
