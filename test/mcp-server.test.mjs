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

const SERVER = join(dirname(dirname(fileURLToPath(import.meta.url))), 'server', 'index.mjs');

/** Gửi loạt frame vào server, gom frame trả về (theo dòng) rồi đóng stdin. */
function talk(frames, { env = {} } = {}) {
  return new Promise((resolve, reject) => {
    const home = mkdtempSync(join(tmpdir(), 'gdrive-mcp-home-'));
    const child = spawn(process.execPath, [SERVER], {
      // HOME tạm rỗng: server không được đọc trúng cấu hình thật của máy chạy test.
      env: { ...process.env, HOME: home, USERPROFILE: home, ...env },
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
    env: { ...process.env, HOME: home, USERPROFILE: home, ...env },
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

test('notification KHÔNG được trả lời', async () => {
  const { msgs } = await talk([INIT, { jsonrpc: '2.0', method: 'notifications/initialized' }]);
  assert.equal(msgs.length, 1, 'chỉ có đúng 1 frame trả về (của initialize)');
});

test('tools/list chạy được KHÔNG cần credential', async () => {
  const { msgs } = await talk([INIT, { jsonrpc: '2.0', id: 1, method: 'tools/list' }]);
  const tools = msgs.find((m) => m.id === 1).result.tools;
  assert.ok(tools.length >= 5);
  for (const t of tools) {
    assert.ok(t.name && t.description && t.inputSchema, `tool ${t.name} thiếu field`);
    assert.equal(t.inputSchema.type, 'object');
  }
});

test('mặc định readonly: KHÔNG lộ tool ghi', async () => {
  const { msgs } = await talk([INIT, { jsonrpc: '2.0', id: 1, method: 'tools/list' }]);
  const names = msgs.find((m) => m.id === 1).result.tools.map((t) => t.name);
  assert.ok(names.includes('gdrive_sheet_read'));
  assert.equal(names.includes('gdrive_sheet_write'), false, 'model không được thấy tool ghi');
  assert.equal(names.includes('gdrive_upload'), false);
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
  const { msgs } = await talk([
    INIT,
    {
      jsonrpc: '2.0',
      id: 6,
      method: 'tools/call',
      // URL rác → parseGoogleUrl ném UrlError ngay, không cần mạng.
      params: { name: 'gdrive_sheet_read', arguments: { url_or_id: 'x' } },
    },
  ]);
  const res = msgs.find((m) => m.id === 6);
  assert.equal(res.error, undefined, 'không được là lỗi protocol');
  assert.equal(res.result.isError, true);
  assert.match(res.result.content[0].text, /không phải URL Google hợp lệ/);
});

test('config đổi readonly → readwrite: ping bắn list_changed, tools/list có tool ghi', async () => {
  const home = mkdtempSync(join(tmpdir(), 'gdrive-mcp-reload-'));
  try {
    writeConfig(home, { mode: 'readonly' });
    const server = startServer({ home });
    server.send(INIT);
    await server.waitFor((m) => m.id === 0);
    server.send({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    const before = await server.waitFor((m) => m.id === 1);
    assert.equal(before.result.tools.some((t) => t.name === 'gdrive_sheet_write'), false);

    writeConfig(home, { mode: 'readwrite' });
    server.send({ jsonrpc: '2.0', id: 2, method: 'ping' });
    await server.waitFor((m) => m.method === 'notifications/tools/list_changed');
    await server.waitFor((m) => m.id === 2);
    server.send({ jsonrpc: '2.0', id: 3, method: 'tools/list' });
    const after = await server.waitFor((m) => m.id === 3);
    assert.equal(after.result.tools.some((t) => t.name === 'gdrive_sheet_write'), true);

    server.child.stdin.end();
    const closed = await server.close;
    assert.equal(closed.code, 0);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('config đổi credential nhưng vẫn readonly: không bắn list_changed và tools/list vẫn không có tool ghi', async () => {
  const home = mkdtempSync(join(tmpdir(), 'gdrive-mcp-reload-credential-'));
  try {
    writeConfig(home, { mode: 'readonly', clientEmail: 'old-sa@proj.iam.gserviceaccount.com' });
    const server = startServer({ home });
    server.send(INIT);
    await server.waitFor((m) => m.id === 0);
    server.send({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    const before = await server.waitFor((m) => m.id === 1);
    assert.equal(before.result.tools.some((t) => t.name === 'gdrive_sheet_write'), false);

    writeConfig(home, { mode: 'readonly', clientEmail: 'rotated-sa@proj.iam.gserviceaccount.com' });
    server.send({ jsonrpc: '2.0', id: 2, method: 'ping' });
    await server.waitFor((m) => m.id === 2);
    assert.equal(
      server.msgs.some((m) => m.method === 'notifications/tools/list_changed'),
      false,
    );

    server.send({ jsonrpc: '2.0', id: 3, method: 'tools/list' });
    const after = await server.waitFor((m) => m.id === 3);
    assert.equal(after.result.tools.some((t) => t.name === 'gdrive_sheet_write'), false);

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
    writeConfig(home, { mode: 'readonly' });
    const server = startServer({ home, env: { CLAUDE_PLUGIN_DATA: higherDir } });
    server.send(INIT);
    await server.waitFor((m) => m.id === 0);
    server.send({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    const before = await server.waitFor((m) => m.id === 1);
    assert.equal(before.result.tools.some((t) => t.name === 'gdrive_sheet_write'), false);

    writeConfig(home, { mode: 'readwrite' });
    server.send({ jsonrpc: '2.0', id: 2, method: 'ping' });
    await server.waitFor((m) => m.method === 'notifications/tools/list_changed');
    await server.waitFor((m) => m.id === 2);
    server.send({ jsonrpc: '2.0', id: 3, method: 'tools/list' });
    const after = await server.waitFor((m) => m.id === 3);
    assert.equal(after.result.tools.some((t) => t.name === 'gdrive_sheet_write'), true);

    server.child.stdin.end();
    const closed = await server.close;
    assert.equal(closed.code, 0);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('config ưu tiên cao hơn xuất hiện: legacy readonly → plugin readwrite reload được', async () => {
  const home = mkdtempSync(join(tmpdir(), 'gdrive-mcp-reload-priority-'));
  try {
    writeLegacyConfig(home, { mode: 'readonly' });
    const server = startServer({ home });
    server.send(INIT);
    await server.waitFor((m) => m.id === 0);
    server.send({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    const before = await server.waitFor((m) => m.id === 1);
    assert.equal(before.result.tools.some((t) => t.name === 'gdrive_sheet_write'), false);

    writeConfig(home, { mode: 'readwrite' });
    server.send({ jsonrpc: '2.0', id: 2, method: 'ping' });
    await server.waitFor((m) => m.method === 'notifications/tools/list_changed');
    await server.waitFor((m) => m.id === 2);
    server.send({ jsonrpc: '2.0', id: 3, method: 'tools/list' });
    const after = await server.waitFor((m) => m.id === 3);
    assert.equal(after.result.tools.some((t) => t.name === 'gdrive_sheet_write'), true);

    server.child.stdin.end();
    const closed = await server.close;
    assert.equal(closed.code, 0);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('config đổi readwrite → readonly: tool ghi biến mất và tools/call bị từ chối', async () => {
  const home = mkdtempSync(join(tmpdir(), 'gdrive-mcp-reload-down-'));
  try {
    writeConfig(home, { mode: 'readwrite' });
    const server = startServer({ home });
    server.send(INIT);
    await server.waitFor((m) => m.id === 0);
    server.send({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    const before = await server.waitFor((m) => m.id === 1);
    assert.equal(before.result.tools.some((t) => t.name === 'gdrive_sheet_write'), true);

    writeConfig(home, { mode: 'readonly' });
    server.send({ jsonrpc: '2.0', id: 2, method: 'ping' });
    await server.waitFor((m) => m.method === 'notifications/tools/list_changed');
    await server.waitFor((m) => m.id === 2);
    server.send({ jsonrpc: '2.0', id: 3, method: 'tools/list' });
    const after = await server.waitFor((m) => m.id === 3);
    assert.equal(after.result.tools.some((t) => t.name === 'gdrive_sheet_write'), false);

    server.send({
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: 'gdrive_sheet_write', arguments: {} },
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
    { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'gdrive_list', arguments: {} } },
  ]);
  const res = msgs.find((m) => m.id === 7);
  assert.equal(code, 0);
  assert.equal(res.result.isError, true);
  assert.match(res.result.content[0].text, /Không tìm thấy credential/);
});

test('stdout backpressure: đóng stdin ngay vẫn flush xong frame lớn trước khi exit', async () => {
  const home = mkdtempSync(join(tmpdir(), 'gdrive-mcp-backpressure-'));
  const t0 = Date.now();
  const child = spawn(process.execPath, [SERVER], {
    env: { ...process.env, HOME: home, USERPROFILE: home },
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
        name: 'gdrive_file_info',
        arguments: { url_or_id: `https://example.com/${'x'.repeat(4_000_000)}` },
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

test('buildTools: readwrite mở đủ 7 tool, readonly còn 5', () => {
  const ctx = { getClient: () => ({}), mode: 'readwrite' };
  assert.equal(buildTools(ctx).length, 7);
  assert.equal(buildTools({ ...ctx, mode: 'readonly' }).length, 5);
});

test('buildTools: mọi tool có schema hợp lệ và additionalProperties=false', () => {
  for (const t of buildTools({ getClient: () => ({}), mode: 'readwrite' })) {
    assert.equal(t.inputSchema.additionalProperties, false, `${t.name} phải chặn field lạ`);
    assert.equal(typeof t.run, 'function');
    assert.ok(t.description.length > 40, `${t.name}: mô tả quá ngắn để model chọn đúng tool`);
  }
});

test('buildTools: tool ghi được đánh dấu write=true', () => {
  const w = buildTools({ getClient: () => ({}), mode: 'readwrite' })
    .filter((t) => t.write)
    .map((t) => t.name);
  assert.deepEqual(w.sort(), ['gdrive_sheet_write', 'gdrive_upload']);
});
