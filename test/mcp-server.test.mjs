// MCP server: chạy server THẬT như tiến trình con, feed byte-stream JSON-RPC, đọc frame trả về.
// Không cần mạng, không cần credential — client dựng lazy nên tools/list vẫn chạy.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { test } from 'node:test';

import { buildTools } from '../src/tools.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SERVER = join(ROOT, 'server', 'index.mjs');
const CLI = join(ROOT, 'bin', 'cli.mjs');

/**
 * Env của tiến trình con: HOME tạm rỗng, và mọi biến trỏ tới thư mục config đều bị ghim vào
 * HOME tạm — server không được đọc trúng cấu hình thật của máy chạy test.
 */
function sandboxEnv(home, env = {}) {
  return {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    APPDATA: join(home, 'AppData', 'Roaming'),
    XDG_CONFIG_HOME: join(home, '.config'),
    GDRIVE_CONFIG_DIR: '',
    CLAUDE_PLUGIN_DATA: '',
    ...env,
  };
}

/** Gửi loạt frame vào server, gom frame trả về (theo dòng) rồi đóng stdin. */
function talk(frames, { env = {}, args = [SERVER], home = mkdtempSync(join(tmpdir(), 'gdrive-mcp-home-')) } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      env: sandboxEnv(home, env),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => {
      out += d;
    });
    child.stderr.on('data', (d) => {
      err += d;
    });
    child.on('error', reject);
    child.on('close', (code) => {
      const msgs = out
        .split('\n')
        .filter((l) => l.trim())
        .map((l) => {
          try {
            return JSON.parse(l);
          } catch {
            // Đây chính là ca hỏng cần bắt: có gì đó KHÔNG phải JSON lọt vào stdout.
            throw new Error(`stdout có dòng không phải JSON-RPC: ${JSON.stringify(l)}`);
          }
        });
      rmSync(home, { recursive: true, force: true });
      resolve({ msgs, stderr: err, code });
    });
    for (const f of frames) child.stdin.write(`${JSON.stringify(f)}\n`);
    child.stdin.end();
  });
}

const INIT = {
  jsonrpc: '2.0',
  id: 0,
  method: 'initialize',
  params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } },
};

function writeConfig(home, cfg) {
  const dir = join(home, '.claude', 'plugins', 'data', 'gdrive-gdrive-cli');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'config.json');
  writeFileSync(file, `${JSON.stringify({
    clientEmail: 'sa@proj.iam.gserviceaccount.com',
    privateKey: 'not-a-real-key',
    ...cfg,
  })}\n`);
  return file;
}

function writeLegacyConfig(home, cfg) {
  const dir = join(home, '.claude');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'gdrive.json');
  writeFileSync(file, `${JSON.stringify({
    clientEmail: 'sa@proj.iam.gserviceaccount.com',
    privateKey: 'not-a-real-key',
    ...cfg,
  })}\n`);
  return file;
}

function writeBrokenConfig(file) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, '{ đây không phải JSON\n');
  return file;
}

function startServer({ home = mkdtempSync(join(tmpdir(), 'gdrive-mcp-live-')), env = {}, nodeArgs = [] } = {}) {
  const child = spawn(process.execPath, [...nodeArgs, SERVER], {
    env: sandboxEnv(home, env),
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const msgs = [];
  let stderr = '';
  const waiters = new Set();
  const findFrame = (predicate) => {
    try {
      return { frame: msgs.find(predicate) };
    } catch (err) {
      return { err };
    }
  };
  const settleWaiters = () => {
    for (const waiter of [...waiters]) {
      const { frame, err } = findFrame(waiter.predicate);
      if (err) {
        clearTimeout(waiter.timer);
        waiters.delete(waiter);
        waiter.reject(err);
      } else if (frame) {
        clearTimeout(waiter.timer);
        waiters.delete(waiter);
        waiter.resolve(frame);
      }
    }
  };
  const rejectWaiters = (err) => {
    for (const waiter of [...waiters]) {
      clearTimeout(waiter.timer);
      waiter.reject(err);
    }
    waiters.clear();
  };
  child.stderr.on('data', (d) => {
    stderr += d;
  });
  child.stdout.on('data', (d) => {
    for (const line of String(d).split('\n')) {
      if (!line.trim()) continue;
      try {
        msgs.push(JSON.parse(line));
        settleWaiters();
      } catch {
        rejectWaiters(new Error(`stdout có dòng không phải JSON-RPC: ${JSON.stringify(line)}`));
      }
    }
  });
  const close = new Promise((resolve) => child.on('close', (code) => resolve({ code, stderr })));
  const send = (frame) => child.stdin.write(`${JSON.stringify(frame)}\n`);
  const waitFor = (predicate) => new Promise((resolve, reject) => {
    const { frame, err } = findFrame(predicate);
    if (err) return reject(err);
    if (frame) return resolve(frame);

    const waiter = {
      predicate,
      resolve,
      reject,
      timer: setTimeout(() => {
        waiters.delete(waiter);
        reject(new Error(`timeout chờ frame; stderr=${stderr}; msgs=${JSON.stringify(msgs)}`));
      }, 5000),
    };
    waiters.add(waiter);
  });
  return { child, home, msgs, send, waitFor, close };
}

test('handshake: initialize → capabilities.tools + serverInfo', async () => {
  const { msgs } = await talk([INIT]);
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].id, 0);
  assert.deepEqual(msgs[0].result.capabilities, { tools: { listChanged: true } });
  assert.equal(msgs[0].result.serverInfo.name, 'gdrive');
  assert.equal(msgs[0].result.protocolVersion, '2025-06-18', 'echo lại version của client');
});

test('initialize trả instructions ngắn, trung lập (không dính biến riêng của Claude)', async () => {
  const { msgs } = await talk([INIT]);
  const { instructions } = msgs[0].result;
  assert.equal(typeof instructions, 'string');
  assert.match(instructions, /drive_read/);
  assert.doesNotMatch(instructions, /CLAUDE_PLUGIN_ROOT|\/gdrive-setup/);
  assert.ok(Buffer.byteLength(instructions) < 1500, `instructions quá dài: ${Buffer.byteLength(instructions)} byte`);
});

test('`gdrive mcp`: CLI chạy server, trả lời tools/list và thoát 0 khi stdin đóng', async () => {
  const { msgs, code } = await talk([INIT, { jsonrpc: '2.0', id: 1, method: 'tools/list' }], { args: [CLI, 'mcp'] });
  assert.equal(code, 0);
  assert.equal(msgs.find((m) => m.id === 0).result.serverInfo.name, 'gdrive');
  const names = msgs.find((m) => m.id === 1).result.tools.map((t) => t.name);
  assert.ok(names.includes('drive_read'));
});

test('server đọc config ở thư mục trung lập (máy không có plugin Claude)', async () => {
  const home = mkdtempSync(join(tmpdir(), 'gdrive-mcp-home-'));
  // Trùng với sandboxEnv: Windows đọc APPDATA, còn lại đọc XDG_CONFIG_HOME.
  const dir = process.platform === 'win32'
    ? join(home, 'AppData', 'Roaming', 'gdrive-cli')
    : join(home, '.config', 'gdrive-cli');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'config.json'), JSON.stringify({
    clientEmail: 'sa@proj.iam.gserviceaccount.com',
    privateKey: 'not-a-real-key',
    folders: [{ id: 'f1aaaaaaaa', name: 'run', access: 'write' }],
  }));
  const { msgs } = await talk([INIT, { jsonrpc: '2.0', id: 1, method: 'tools/list' }], { home });
  const names = msgs.find((m) => m.id === 1).result.tools.map((t) => t.name);
  assert.ok(names.includes('sheet_write'), 'folder write từ config trung lập phải mở tool ghi');
});

test('notification KHÔNG được trả lời', async () => {
  const { msgs } = await talk([INIT, { jsonrpc: '2.0', method: 'notifications/initialized' }]);
  assert.equal(msgs.length, 1, 'chỉ có đúng 1 frame trả về (của initialize)');
});

test('tools/list chạy được KHÔNG cần credential', async () => {
  const { msgs } = await talk([INIT, { jsonrpc: '2.0', id: 1, method: 'tools/list' }]);
  const tools = msgs.find((m) => m.id === 1).result.tools;
  assert.ok(tools.length >= 2);
  for (const t of tools) {
    assert.ok(t.name && t.description && t.inputSchema, `tool ${t.name} thiếu field`);
    assert.equal(t.inputSchema.type, 'object');
  }
});

test('mặc định (chưa có folder write): KHÔNG lộ tool ghi', async () => {
  const { msgs } = await talk([INIT, { jsonrpc: '2.0', id: 1, method: 'tools/list' }]);
  const names = msgs.find((m) => m.id === 1).result.tools.map((t) => t.name);
  assert.deepEqual(names, ['drive_ls', 'drive_read'], 'model không được thấy tool ghi');
});

test('ping', async () => {
  const { msgs } = await talk([INIT, { jsonrpc: '2.0', id: 2, method: 'ping' }]);
  assert.deepEqual(msgs.find((m) => m.id === 2).result, {});
});

test('method lạ → -32601, và KHÔNG làm chết server', async () => {
  const { msgs } = await talk([
    INIT,
    { jsonrpc: '2.0', id: 3, method: 'khong/co/method/nay' },
    { jsonrpc: '2.0', id: 4, method: 'ping' },
  ]);
  assert.equal(msgs.find((m) => m.id === 3).error.code, -32601);
  assert.ok(msgs.find((m) => m.id === 4), 'server phải còn sống sau lỗi');
});

test('tool không tồn tại → -32602', async () => {
  const { msgs } = await talk([
    INIT,
    { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'khong_co', arguments: {} } },
  ]);
  assert.equal(msgs.find((m) => m.id === 5).error.code, -32602);
});

test('frame rác không phải JSON: bỏ qua, không làm hỏng stdout', async () => {
  const child = spawn(process.execPath, [SERVER], { stdio: ['pipe', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d) => {
    out += d;
  });
  const done = new Promise((r) => child.on('close', r));
  child.stdin.write('đây không phải json\n');
  child.stdin.write(`${JSON.stringify(INIT)}\n`);
  child.stdin.end();
  await done;
  const lines = out.split('\n').filter((l) => l.trim());
  assert.equal(lines.length, 1);
  assert.equal(JSON.parse(lines[0]).id, 0);
});

test('lỗi của tool trả về isError (model đọc được), KHÔNG phải lỗi protocol', async () => {
  const home = mkdtempSync(join(tmpdir(), 'gdrive-mcp-home-'));
  writeConfig(home, { folders: [{ id: 'f1aaaaaaaa', name: 'run', access: 'read' }] });
  const { msgs } = await talk([
    INIT,
    {
      jsonrpc: '2.0',
      id: 6,
      method: 'tools/call',
      // URL rác → parseGoogleUrl ném UrlError ngay, không cần mạng.
      params: { name: 'drive_read', arguments: { target: 'x' } },
    },
  ], { home });
  const res = msgs.find((m) => m.id === 6);
  assert.equal(res.error, undefined, 'không được là lỗi protocol');
  assert.equal(res.result.isError, true);
  assert.match(res.result.content[0].text, /không phải URL Google hợp lệ/);
});

test('config đổi folder read → write: ping bắn list_changed, tools/list có tool ghi', async () => {
  const home = mkdtempSync(join(tmpdir(), 'gdrive-mcp-reload-'));
  try {
    writeConfig(home, { folders: [{ id: 'f1aaaaaaaa', name: 'run', access: 'read' }] });
    const server = startServer({ home });
    server.send(INIT);
    await server.waitFor((m) => m.id === 0);
    server.send({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    const before = await server.waitFor((m) => m.id === 1);
    assert.equal(before.result.tools.some((t) => t.name === 'sheet_write'), false);

    writeConfig(home, { folders: [{ id: 'f1aaaaaaaa', name: 'run', access: 'write' }] });
    server.send({ jsonrpc: '2.0', id: 2, method: 'ping' });
    await server.waitFor((m) => m.method === 'notifications/tools/list_changed');
    await server.waitFor((m) => m.id === 2);
    server.send({ jsonrpc: '2.0', id: 3, method: 'tools/list' });
    const after = await server.waitFor((m) => m.id === 3);
    assert.equal(after.result.tools.some((t) => t.name === 'sheet_write'), true);

    server.child.stdin.end();
    const closed = await server.close;
    assert.equal(closed.code, 0);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('config đổi credential nhưng folder vẫn read: không bắn list_changed và tools/list vẫn không có tool ghi', async () => {
  const home = mkdtempSync(join(tmpdir(), 'gdrive-mcp-reload-credential-'));
  try {
    writeConfig(home, { folders: [{ id: 'f1aaaaaaaa', name: 'run', access: 'read' }], clientEmail: 'old-sa@proj.iam.gserviceaccount.com' });
    const server = startServer({ home });
    server.send(INIT);
    await server.waitFor((m) => m.id === 0);
    server.send({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    const before = await server.waitFor((m) => m.id === 1);
    assert.equal(before.result.tools.some((t) => t.name === 'sheet_write'), false);

    writeConfig(home, { folders: [{ id: 'f1aaaaaaaa', name: 'run', access: 'read' }], clientEmail: 'rotated-sa@proj.iam.gserviceaccount.com' });
    server.send({ jsonrpc: '2.0', id: 2, method: 'ping' });
    await server.waitFor((m) => m.id === 2);
    assert.equal(
      server.msgs.some((m) => m.method === 'notifications/tools/list_changed'),
      false,
    );

    server.send({ jsonrpc: '2.0', id: 3, method: 'tools/list' });
    const after = await server.waitFor((m) => m.id === 3);
    assert.equal(after.result.tools.some((t) => t.name === 'sheet_write'), false);

    server.child.stdin.end();
    const closed = await server.close;
    assert.equal(closed.code, 0);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('config hỏng ưu tiên cao không chặn reload của config hợp lệ thấp hơn', async () => {
  const home = mkdtempSync(join(tmpdir(), 'gdrive-mcp-reload-broken-priority-'));
  const higherDir = join(home, '.claude', 'plugins', 'data', 'gdrive-inline');
  try {
    writeBrokenConfig(join(higherDir, 'config.json'));
    writeConfig(home, { folders: [{ id: 'f1aaaaaaaa', name: 'run', access: 'read' }] });
    const server = startServer({ home, env: { CLAUDE_PLUGIN_DATA: higherDir } });
    server.send(INIT);
    await server.waitFor((m) => m.id === 0);
    server.send({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    const before = await server.waitFor((m) => m.id === 1);
    assert.equal(before.result.tools.some((t) => t.name === 'sheet_write'), false);

    writeConfig(home, { folders: [{ id: 'f1aaaaaaaa', name: 'run', access: 'write' }] });
    server.send({ jsonrpc: '2.0', id: 2, method: 'ping' });
    await server.waitFor((m) => m.method === 'notifications/tools/list_changed');
    await server.waitFor((m) => m.id === 2);
    server.send({ jsonrpc: '2.0', id: 3, method: 'tools/list' });
    const after = await server.waitFor((m) => m.id === 3);
    assert.equal(after.result.tools.some((t) => t.name === 'sheet_write'), true);

    server.child.stdin.end();
    const closed = await server.close;
    assert.equal(closed.code, 0);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('config ưu tiên cao hơn xuất hiện: legacy read → plugin write reload được', async () => {
  const home = mkdtempSync(join(tmpdir(), 'gdrive-mcp-reload-priority-'));
  try {
    writeLegacyConfig(home, { folders: [{ id: 'f1aaaaaaaa', name: 'run', access: 'read' }] });
    const server = startServer({ home });
    server.send(INIT);
    await server.waitFor((m) => m.id === 0);
    server.send({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    const before = await server.waitFor((m) => m.id === 1);
    assert.equal(before.result.tools.some((t) => t.name === 'sheet_write'), false);

    writeConfig(home, { folders: [{ id: 'f1aaaaaaaa', name: 'run', access: 'write' }] });
    server.send({ jsonrpc: '2.0', id: 2, method: 'ping' });
    await server.waitFor((m) => m.method === 'notifications/tools/list_changed');
    await server.waitFor((m) => m.id === 2);
    server.send({ jsonrpc: '2.0', id: 3, method: 'tools/list' });
    const after = await server.waitFor((m) => m.id === 3);
    assert.equal(after.result.tools.some((t) => t.name === 'sheet_write'), true);

    server.child.stdin.end();
    const closed = await server.close;
    assert.equal(closed.code, 0);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('config đổi folder write → read: tool ghi biến mất và tools/call bị từ chối', async () => {
  const home = mkdtempSync(join(tmpdir(), 'gdrive-mcp-reload-down-'));
  try {
    writeConfig(home, { folders: [{ id: 'f1aaaaaaaa', name: 'run', access: 'write' }] });
    const server = startServer({ home });
    server.send(INIT);
    await server.waitFor((m) => m.id === 0);
    server.send({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    const before = await server.waitFor((m) => m.id === 1);
    assert.equal(before.result.tools.some((t) => t.name === 'sheet_write'), true);

    writeConfig(home, { folders: [{ id: 'f1aaaaaaaa', name: 'run', access: 'read' }] });
    server.send({ jsonrpc: '2.0', id: 2, method: 'ping' });
    await server.waitFor((m) => m.method === 'notifications/tools/list_changed');
    await server.waitFor((m) => m.id === 2);
    server.send({ jsonrpc: '2.0', id: 3, method: 'tools/list' });
    const after = await server.waitFor((m) => m.id === 3);
    assert.equal(after.result.tools.some((t) => t.name === 'sheet_write'), false);

    server.send({
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: 'sheet_write', arguments: {} },
    });
    const rejected = await server.waitFor((m) => m.id === 4);
    assert.equal(rejected.error.code, -32602);

    server.child.stdin.end();
    const closed = await server.close;
    assert.equal(closed.code, 0);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('tools/call lỗi credential rồi đóng stdin ngay vẫn trả response và exit 0', async () => {
  const { msgs, code } = await talk([
    INIT,
    { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'drive_read', arguments: { target: 'abcdefghij' } } },
  ]);
  const res = msgs.find((m) => m.id === 7);
  assert.equal(code, 0);
  assert.equal(res.result.isError, true);
  assert.match(res.result.content[0].text, /Không tìm thấy credential/);
});

test('stdout backpressure: đóng stdin ngay vẫn flush xong frame lớn trước khi exit', async () => {
  const home = mkdtempSync(join(tmpdir(), 'gdrive-mcp-backpressure-'));
  // Cần credential + folder để tool đi tới parseGoogleUrl: lỗi của nó chứa nguyên URL 4 MB.
  writeConfig(home, { folders: [{ id: 'f1aaaaaaaa', name: 'run', access: 'read' }] });
  const t0 = Date.now();
  const child = spawn(process.execPath, [SERVER], {
    env: sandboxEnv(home),
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let out = '';
  let err = '';
  child.stderr.on('data', (d) => {
    err += d;
  });

  let firstDataAt = null;
  child.stdout.on('data', (d) => {
    if (firstDataAt === null) firstDataAt = Date.now() - t0;
    out += d;
  });
  // Listener phải gắn NGAY, trước khi làm bất cứ việc gì khác: nếu child thoát
  // trong lúc stream còn tạm dừng và CHƯA có listener 'data', flushStdio() của
  // child_process sẽ resume() stream để 'close' bắn được — và dữ liệu chưa ai
  // đọc bị đổ bỏ luôn. pause() ngay dưới đây mới là thứ tạo backpressure thật
  // (Node ngừng đọc pipe khi đầy highWaterMark trên POSIX); trì hoãn việc gắn
  // listener không phải là cách đúng để giữ dữ liệu lại.
  child.stdout.pause();

  let closeAt = null;
  const close = new Promise((resolve) =>
    child.on('close', (code) => {
      closeAt = Date.now() - t0;
      resolve(code);
    }),
  );
  let stdoutEndAt = null;
  const stdoutEnd = new Promise((resolve, reject) => {
    child.stdout.on('end', () => {
      stdoutEndAt = Date.now() - t0;
      resolve();
    });
    child.stdout.on('error', reject);
  });
  const timeout = new Promise((_, reject) => {
    setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`timeout chờ server thoát; stderr=${err}`));
    }, 10_000);
  });

  let stdinBytesWritten = 0;
  let stdinEnded = false;
  let stdinError = null;
  child.stdin.on('error', (e) => {
    stdinError = e;
  });

  try {
    const initChunk = `${JSON.stringify(INIT)}\n`;
    child.stdin.write(initChunk);
    stdinBytesWritten += Buffer.byteLength(initChunk);

    const bigFrame = `${JSON.stringify({
      jsonrpc: '2.0',
      id: 8,
      method: 'tools/call',
      params: {
        name: 'drive_read',
        arguments: { target: `https://example.com/${'x'.repeat(4_000_000)}` },
      },
    })}\n`;
    stdinBytesWritten += Buffer.byteLength(bigFrame);
    child.stdin.end(bigFrame, () => {
      stdinEnded = true;
    });

    await new Promise((resolve) => setTimeout(resolve, 200));
    child.stdout.resume();

    const [code] = await Promise.race([Promise.all([close, stdoutEnd]), timeout]);

    // Parse khoan dung: một dòng bị cắt dở không được ném SyntaxError trần ra khỏi
    // test, vì như vậy sẽ mất toàn bộ diag khi assert dưới thất bại.
    const lines = out.split('\n').filter((line) => line.trim());
    const msgs = [];
    const brokenLines = [];
    lines.forEach((line, index) => {
      try {
        msgs.push(JSON.parse(line));
      } catch {
        brokenLines.push({
          index,
          length: line.length,
          tail120: line.slice(-120),
        });
      }
    });
    const res = msgs.find((m) => m.id === 8);

    const frameSummary = msgs.map((m) => ({
      id: m.id,
      method: m.method,
      hasResult: Object.prototype.hasOwnProperty.call(m, 'result'),
      hasError: Object.prototype.hasOwnProperty.call(m, 'error'),
    }));
    const diag = [
      `exit code=${code}`,
      `stdinBytesWritten=${stdinBytesWritten}`,
      `stdinEnded=${stdinEnded}`,
      `stdinError=${stdinError ? stdinError.message : 'none'}`,
      `out.length=${out.length}`,
      `frames=${JSON.stringify(frameSummary)}`,
      `brokenLines=${JSON.stringify(brokenLines)}`,
      `out.head200=${JSON.stringify(out.slice(0, 200))}`,
      `out.tail200=${JSON.stringify(out.slice(-200))}`,
      `child.stdout.bytesRead=${child.stdout.bytesRead}`,
      `t.firstData=${firstDataAt}`,
      `t.stdoutEnd=${stdoutEndAt}`,
      `t.close=${closeAt}`,
      `stderr=${err}`,
    ].join(' | ');

    if (brokenLines.length > 0) {
      assert.fail(`dòng trong out parse hỏng (frame bị cắt dở?). ${diag}`);
    }

    assert.ok(res, `thiếu frame id:8. ${diag}`);
    assert.equal(code, 0, diag);
    assert.equal(res.result.isError, true, diag);
    assert.match(res.result.content[0].text, /Không tách được file id/, diag);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('Node dưới 18.17: server báo stderr rồi thoát khác 0 trước handshake', async () => {
  const home = mkdtempSync(join(tmpdir(), 'gdrive-mcp-node-'));
  const preload = join(home, 'mock-version.mjs');
  writeFileSync(preload, "Object.defineProperty(process, 'version', { value: 'v18.16.0' });\n");
  try {
    const server = startServer({ home, nodeArgs: ['--import', pathToFileURL(preload).href] });
    server.child.stdin.end();
    const closed = await server.close;
    assert.notEqual(closed.code, 0);
    assert.match(closed.stderr, /Cần Node >= 18\.17/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// ── buildTools (không qua tiến trình con) ───────────────────────────────────

const FOLDERS_W = [{ id: 'f1aaaaaaaa', name: 'run', access: 'write' }];
const FOLDERS_R = [{ id: 'f1aaaaaaaa', name: 'run', access: 'read' }];

test('buildTools: có folder write mở đủ 5 tool, chỉ read còn 2', () => {
  const ctx = { getClient: () => ({}), folders: FOLDERS_W };
  assert.equal(buildTools(ctx).length, 5);
  assert.equal(buildTools({ ...ctx, folders: FOLDERS_R }).length, 2);
});

test('buildTools: mọi tool có schema hợp lệ và additionalProperties=false', () => {
  for (const t of buildTools({ getClient: () => ({}), folders: FOLDERS_W })) {
    assert.equal(t.inputSchema.additionalProperties, false, `${t.name} phải chặn field lạ`);
    assert.equal(typeof t.run, 'function');
    assert.ok(t.description.length > 40, `${t.name}: mô tả quá ngắn để model chọn đúng tool`);
  }
});

test('buildTools: tool ghi được đánh dấu write=true', () => {
  const w = buildTools({ getClient: () => ({}), folders: FOLDERS_W })
    .filter((t) => t.write)
    .map((t) => t.name);
  assert.deepEqual(w.sort(), ['drive_create', 'drive_move', 'sheet_write']);
});

test('tools/call trả văn bản thuần, lỗi phạm vi bắt đầu bằng ✗ và là isError', async () => {
  const home = mkdtempSync(join(tmpdir(), 'gdrive-mcp-home-'));
  writeConfig(home, { folders: [] });
  const { msgs } = await talk([INIT, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'drive_read', arguments: { target: 'abcdefghij' } } }], { home });
  const r = msgs.find((m) => m.id === 1).result;
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /^✗ Chưa có folder nào được phép/);
  assert.doesNotMatch(r.content[0].text, /^\{/, 'không bọc JSON');
});

test('config folders hỏng: server vẫn trả lời tools/list, tools/call báo lỗi cấu hình', async () => {
  const home = mkdtempSync(join(tmpdir(), 'gdrive-mcp-home-'));
  writeConfig(home, { folders: [{ id: '1', name: 'Có Dấu', access: 'read' }] });
  const { msgs, code } = await talk([INIT, { jsonrpc: '2.0', id: 1, method: 'tools/list' }, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'drive_ls', arguments: {} } }], { home });
  assert.equal(code, 0);
  assert.ok(msgs.find((m) => m.id === 1).result.tools.length >= 2);
  assert.match(msgs.find((m) => m.id === 2).result.content[0].text, /✗ Tên "Có Dấu" không hợp lệ/);
});
