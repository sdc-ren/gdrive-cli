// Đăng ký MCP cho Codex / Copilot / Cursor / Kiro — chạy trên HOME + cwd tạm, không đụng
// config thật của máy.

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';

import {
  CLIENT_IDS,
  CLIENTS,
  findRegistrations,
  installClient,
  readTomlServer,
  removeTomlServer,
  resolveLaunch,
  runClientUninstall,
  runInstall,
  tomlString,
  uninstallClient,
  upsertJsonServer,
  upsertTomlServer,
} from '../src/clients.mjs';
import { runStatus } from '../src/status.mjs';

const LAUNCH = { nodePath: '/usr/local/bin/node', serverPath: '/opt/gdrive-cli/server/index.mjs' };

async function sandbox(fn) {
  const root = mkdtempSync(join(tmpdir(), 'gdrive-clients-'));
  const home = join(root, 'home');
  const cwd = join(root, 'repo');
  mkdirSync(home, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  // platform cố định 'linux' để đường dẫn VS Code đoán trước được trên mọi OS chạy test.
  const ctx = { home, cwd, env: {}, platform: 'linux', launch: LAUNCH };
  try {
    return await fn(ctx);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const userFile = (id, ctx) => CLIENTS[id].user(ctx);
const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));
const write = (file, text) => {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
};

// ── Từng client: file mới đúng schema ────────────────────────────────────────

test('mọi client: cài cấp user tạo file mới với entry đường dẫn tuyệt đối', async () => {
  await sandbox(async (ctx) => {
    for (const id of CLIENT_IDS) {
      const res = installClient(id, ctx);
      assert.equal(res.ok, true, id);
      assert.equal(res.changed, true, id);
      assert.equal(res.file, userFile(id, ctx));
      const text = readFileSync(res.file, 'utf8');
      assert.ok(text.includes(LAUNCH.serverPath), `${id}: phải trỏ tới server tuyệt đối`);
      assert.doesNotMatch(text, /privateKey|private_key|clientEmail/, `${id}: không được chứa credential`);
    }
  });
});

test('schema riêng: VS Code dùng servers + type stdio; Copilot CLI bắt buộc tools ["*"]; Cursor/Kiro mcpServers', async () => {
  await sandbox(async (ctx) => {
    for (const id of CLIENT_IDS) installClient(id, ctx);
    assert.deepEqual(readJson(userFile('copilot', ctx)).servers.gdrive, {
      type: 'stdio',
      command: LAUNCH.nodePath,
      args: [LAUNCH.serverPath],
    });
    assert.deepEqual(readJson(userFile('copilot-cli', ctx)).mcpServers.gdrive, {
      type: 'local',
      tools: ['*'],
      command: LAUNCH.nodePath,
      args: [LAUNCH.serverPath],
    });
    for (const id of ['cursor', 'kiro']) {
      assert.deepEqual(readJson(userFile(id, ctx)).mcpServers.gdrive, {
        command: LAUNCH.nodePath,
        args: [LAUNCH.serverPath],
      });
    }
    assert.deepEqual(readTomlServer(readFileSync(userFile('codex', ctx), 'utf8'), 'gdrive'), {
      command: LAUNCH.nodePath,
      args: [LAUNCH.serverPath],
    });
  });
});

test('đường dẫn đúng chỗ từng client đọc', async () => {
  await sandbox(async (ctx) => {
    const { home, cwd } = ctx;
    assert.equal(userFile('codex', ctx), join(home, '.codex', 'config.toml'));
    assert.equal(userFile('cursor', ctx), join(home, '.cursor', 'mcp.json'));
    assert.equal(userFile('kiro', ctx), join(home, '.kiro', 'settings', 'mcp.json'));
    assert.equal(userFile('copilot-cli', ctx), join(home, '.copilot', 'mcp-config.json'));
    assert.equal(userFile('copilot', ctx), join(home, '.config', 'Code', 'User', 'mcp.json'));
    assert.equal(
      CLIENTS.copilot.user({ ...ctx, platform: 'darwin' }),
      join(home, 'Library', 'Application Support', 'Code', 'User', 'mcp.json'),
    );
    assert.equal(CLIENTS.copilot.project(ctx), join(cwd, '.vscode', 'mcp.json'));
    assert.equal(CLIENTS.kiro.project(ctx), join(cwd, '.kiro', 'settings', 'mcp.json'));
  });
});

// ── Merge, idempotent, không phá file người dùng ─────────────────────────────

test('JSON: giữ nguyên server và khoá khác; chạy lại lần 2 không đổi gì', async () => {
  await sandbox(async (ctx) => {
    const file = userFile('cursor', ctx);
    write(file, JSON.stringify({ mcpServers: { other: { command: 'x' } }, theme: 'dark' }));
    installClient('cursor', ctx);
    const first = readFileSync(file, 'utf8');
    const cfg = JSON.parse(first);
    assert.deepEqual(cfg.mcpServers.other, { command: 'x' });
    assert.equal(cfg.theme, 'dark');
    assert.ok(cfg.mcpServers.gdrive);

    const again = installClient('cursor', ctx);
    assert.equal(again.changed, false);
    assert.equal(readFileSync(file, 'utf8'), first);
  });
});

test('JSON có comment (JSONC) hoặc hỏng: KHÔNG sửa file, trả đoạn cấu hình để tự dán', async () => {
  await sandbox(async (ctx) => {
    const file = CLIENTS.copilot.project(ctx);
    const jsonc = '{\n  // server của tôi\n  "servers": {}\n}\n';
    write(file, jsonc);
    const res = installClient('copilot', { ...ctx, project: true });
    assert.equal(res.ok, false);
    assert.equal(readFileSync(file, 'utf8'), jsonc, 'file phải còn nguyên');
    assert.match(res.snippet, /"servers"/);
    assert.match(res.snippet, /"gdrive"/);

    assert.equal(upsertJsonServer('[1,2]', 'mcpServers', 'gdrive', {}).ok, false);
    assert.equal(upsertJsonServer('{"mcpServers": []}', 'mcpServers', 'gdrive', {}).ok, false);
  });
});

test('TOML: giữ khối khác, thay đúng khối gdrive (xoá cả bảng con .env), idempotent', async () => {
  await sandbox(async (ctx) => {
    const file = userFile('codex', ctx);
    write(
      file,
      [
        'model = "gpt-5"',
        '',
        '[mcp_servers.other]',
        'command = "other"',
        '',
        '[mcp_servers.gdrive]',
        'command = "cũ"',
        '',
        '[mcp_servers.gdrive.env]',
        'X = "1"',
        '',
        '[profiles.fast]',
        'model = "mini"',
        '',
      ].join('\n'),
    );
    installClient('codex', ctx);
    const text = readFileSync(file, 'utf8');
    assert.match(text, /\[mcp_servers\.other\]\ncommand = "other"/);
    assert.match(text, /\[profiles\.fast\]\nmodel = "mini"/);
    assert.doesNotMatch(text, /cũ|mcp_servers\.gdrive\.env|X = "1"/);
    assert.equal(text.match(/\[mcp_servers\.gdrive\]/g).length, 1);
    assert.deepEqual(readTomlServer(text, 'gdrive').args, [LAUNCH.serverPath]);
    assert.equal(installClient('codex', ctx).changed, false);
  });
});

test('TOML mơ hồ: dotted key, inline table, header có nháy, chuỗi nhiều dòng → từ chối', () => {
  const entry = { command: 'node', args: ['s'] };
  for (const text of [
    'mcp_servers.gdrive.command = "x"\n',
    'mcp_servers = { gdrive = { command = "x" } }\n',
    '[mcp_servers]\ngdrive = { command = "x" }\n',
    '[mcp_servers."gdrive"]\ncommand = "x"\n',
    'note = """\n[mcp_servers.gdrive]\n"""\n',
  ]) {
    assert.equal(upsertTomlServer(text, 'gdrive', entry).ok, false, text);
  }
});

test('TOML: header có khoảng trắng `[ mcp_servers.gdrive ]` vẫn là khối của ta → thay đúng, không nhân đôi', () => {
  const { ok, text } = upsertTomlServer('[ mcp_servers.gdrive ]\ncommand = "x"\n', 'gdrive', { command: 'n', args: [] });
  assert.equal(ok, true);
  assert.doesNotMatch(text, /command = "x"/);
  assert.equal(text.match(/mcp_servers\.gdrive/g).length, 1);
});

test('TOML: đường dẫn Windows ghi bằng literal string, đọc lại đúng từng ký tự', () => {
  const win = 'C:\\Program Files\\nodejs\\node.exe';
  assert.equal(tomlString(win), `'${win}'`);
  const { text } = upsertTomlServer('', 'gdrive', { command: win, args: ['D:\\new\\server\\index.mjs'] });
  assert.deepEqual(readTomlServer(text, 'gdrive'), { command: win, args: ['D:\\new\\server\\index.mjs'] });
  // Có dấu nháy đơn thì rơi về basic string có escape.
  const quoted = tomlString("C:\\it's\\node");
  assert.equal(quoted, '"C:\\\\it\'s\\\\node"');
});

test('TOML: giữ CRLF của file Windows', () => {
  const { text } = upsertTomlServer('model = "x"\r\n', 'gdrive', { command: 'n', args: [] });
  assert.ok(!/[^\r]\n/.test(text), 'mọi xuống dòng phải là CRLF');
});

// ── Cấp project ──────────────────────────────────────────────────────────────

test('--project: ghi `gdrive mcp` vào repo, không chứa đường dẫn máy cá nhân', async () => {
  await sandbox(async (ctx) => {
    for (const id of ['codex', 'copilot', 'cursor', 'kiro']) {
      const res = installClient(id, { ...ctx, project: true });
      assert.ok(res.file.startsWith(ctx.cwd), `${id}: phải ghi trong repo`);
      const text = readFileSync(res.file, 'utf8');
      assert.doesNotMatch(text, new RegExp(ctx.home.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')));
      assert.doesNotMatch(text, /index\.mjs/);
      assert.deepEqual({ command: res.entry.command, args: res.entry.args }, { command: 'gdrive', args: ['mcp'] });
    }
    assert.throws(() => installClient('copilot-cli', { ...ctx, project: true }), /không có config MCP cấp project/);
  });
});

// ── Lệnh chạy server ─────────────────────────────────────────────────────────

test('resolveLaunch: từ chối chạy từ cache npx', () => {
  const root = mkdtempSync(join(tmpdir(), 'gdrive-npx-'));
  try {
    const pkg = join(root, '_npx', 'abc', 'node_modules', 'gdrive-cli');
    write(join(pkg, 'server', 'index.mjs'), '');
    assert.throws(() => resolveLaunch({ root: pkg }), /cache của npx/);
    const ok = resolveLaunch({ execPath: process.execPath });
    assert.ok(ok.serverPath.endsWith(join('server', 'index.mjs')));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── Skill ────────────────────────────────────────────────────────────────────

test('--skill: cài SKILL.md chuẩn vào ~/.agents/skills (Kiro: ~/.kiro/skills), gỡ sạch', async () => {
  await sandbox(async (ctx) => {
    const cursor = installClient('cursor', { ...ctx, skill: true });
    assert.equal(cursor.skill.file, join(ctx.home, '.agents', 'skills', 'gdrive', 'SKILL.md'));
    assert.match(readFileSync(cursor.skill.file, 'utf8'), /^---\nname: gdrive\n/);
    const kiro = installClient('kiro', { ...ctx, skill: true });
    assert.equal(kiro.skill.file, join(ctx.home, '.kiro', 'skills', 'gdrive', 'SKILL.md'));

    uninstallClient('cursor', ctx);
    assert.equal(existsSync(join(ctx.home, '.agents', 'skills', 'gdrive')), false);
  });
});

test('--skill: không ghi đè / không xoá skill "gdrive" của người khác', async () => {
  await sandbox(async (ctx) => {
    const file = join(ctx.home, '.agents', 'skills', 'gdrive', 'SKILL.md');
    write(file, '---\nname: something-else\n---\ncủa tôi\n');
    const res = installClient('codex', { ...ctx, skill: true });
    assert.equal(res.skill.ok, false);
    uninstallClient('codex', ctx);
    assert.equal(readFileSync(file, 'utf8'), '---\nname: something-else\n---\ncủa tôi\n');
  });
});

// ── Gỡ ───────────────────────────────────────────────────────────────────────

test('uninstall --client: gỡ đúng entry gdrive, giữ server khác; không đụng credential', async () => {
  await sandbox(async (ctx) => {
    const cursor = userFile('cursor', ctx);
    write(cursor, JSON.stringify({ mcpServers: { other: { command: 'x' } } }));
    installClient('cursor', ctx);
    installClient('codex', ctx);
    const credential = join(ctx.home, '.config', 'gdrive-cli', 'config.json');
    write(credential, '{}');

    const logs = [];
    assert.equal(runClientUninstall({ client: 'cursor,codex' }, { ...ctx, log: (l) => logs.push(l) }), true);
    assert.deepEqual(readJson(cursor).mcpServers, { other: { command: 'x' } });
    assert.equal(readTomlServer(readFileSync(userFile('codex', ctx), 'utf8'), 'gdrive'), null);
    assert.ok(existsSync(credential), 'gỡ client không được xoá credential');
    assert.equal(removeTomlServer('', 'gdrive').changed, false);
  });
});

// ── CLI + status ─────────────────────────────────────────────────────────────

test('runInstall: nhiều client một lần; client lạ hoặc thiếu --client → lỗi exitCode 2', async () => {
  await sandbox(async (ctx) => {
    const logs = [];
    assert.equal(runInstall({ client: 'cursor,kiro' }, { ...ctx, log: (l) => logs.push(l) }), true);
    assert.ok(existsSync(userFile('cursor', ctx)));
    assert.ok(existsSync(userFile('kiro', ctx)));
    assert.throws(() => runInstall({ client: 'vim' }, { ...ctx, log: () => {} }), (e) => e.exitCode === 2);
    assert.throws(() => runInstall({}, { ...ctx, log: () => {} }), (e) => e.exitCode === 2);
  });
});

test('status: liệt kê client đã đăng ký và báo đỏ khi entry trỏ tới file đã mất', async () => {
  await sandbox(async (ctx) => {
    installClient('cursor', { ...ctx, launch: { nodePath: process.execPath, serverPath: join(ctx.home, 'mất', 'index.mjs') } });
    assert.equal(findRegistrations(ctx)[0].missing.length, 1);

    const logs = [];
    const healthy = await runStatus({ ...ctx, log: (l) => logs.push(l) });
    const out = logs.join('\n');
    assert.equal(healthy, false);
    assert.match(out, /Đã đăng ký cho: Cursor/);
    assert.match(out, /gdrive install --client cursor/);
  });
});
