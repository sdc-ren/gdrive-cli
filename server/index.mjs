#!/usr/bin/env node
// MCP server (stdio) cho gdrive-cli — chạy trong Claude Code plugin.
//
// ⚠️ LUẬT CỨNG: stdout CHỈ được chứa frame JSON-RPC. Một dòng console.log lạc là hỏng
// stream, và Claude Code chỉ báo "lỗi kết nối" mơ hồ, rất tốn công truy. Chuyển hướng
// console.log sang stderr NGAY dòng đầu, trước mọi import có thể lỡ in ra.
console.log = console.error;
console.info = console.error;

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

if (!nodeOk(process.version)) {
  console.error(`[gdrive-mcp] Cần Node >= 18.17, hiện tại ${process.version}.`);
  process.exit(1);
}

const { existsSync, statSync } = await import('node:fs');
const { homedir } = await import('node:os');

const { createClient } = await import('../src/client.mjs');
const { configSearchPaths, readConfigWithSource } = await import('../src/config.mjs');
const { buildTools } = await import('../src/tools.mjs');

// Phiên bản protocol ta biết. Client gửi phiên bản khác thì echo lại của client —
// stdio MCP tương thích ngược tốt, cãi nhau về version chỉ làm hỏng handshake.
const FALLBACK_PROTOCOL = '2025-06-18';
const SERVER_INFO = { name: 'gdrive', version: '0.2.0' };
const SHUTDOWN_TIMEOUT_MS = 30_000;
const pendingWrites = new Set();

function send(msg) {
  let done;
  try {
    done = new Promise((resolve) => {
      process.stdout.write(`${JSON.stringify(msg)}\n`, (err) => {
        if (err && err.code !== 'EPIPE') console.error('[gdrive-mcp] stdout lỗi:', err);
        resolve();
      });
    });
  } catch (err) {
    if (err?.code !== 'EPIPE') return Promise.reject(err);
    return Promise.resolve();
  }
  pendingWrites.add(done);
  done.finally(() => pendingWrites.delete(done));
  return done;
}
process.stdout.on('error', (err) => {
  if (err?.code !== 'EPIPE') console.error('[gdrive-mcp] stdout lỗi:', err);
});
const ok = (id, result) => send({ jsonrpc: '2.0', id, result });
const fail = (id, code, message) => send({ jsonrpc: '2.0', id, error: { code, message } });
const notifyToolsChanged = () => send({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' });

// ── Client dựng LAZY ────────────────────────────────────────────────────────
// Không đụng credential lúc khởi động: server phải spawn được kể cả khi người dùng
// chưa cấu hình, để `tools/list` vẫn chạy và lỗi hiện ra lúc gọi tool (kèm hướng dẫn),
// thay vì server chết câm ngay từ session start.
function fingerprintForConfigs() {
  const parts = [];
  for (const path of configSearchPaths(homedir(), process.env)) {
    if (!existsSync(path)) continue;
    try {
      const st = statSync(path);
      // Rẻ và đủ cho đường ghi của plugin: writeConfig luôn ghi lại file nên mtime đổi.
      // Không bắt ca nội dung đổi mà mtimeMs và size đều bị giữ nguyên — chấp nhận.
      parts.push(`${path}:${st.mtimeMs}:${st.size}`);
    } catch (err) {
      if (err?.code === 'ENOENT') continue;
      console.error('[gdrive-mcp] không stat được config:', err);
    }
  }
  return parts.length ? parts.join('|') : null;
}

function buildState() {
  const cfgWithSource = readConfigWithSource();
  const mode = cfgWithSource?.config?.mode === 'readwrite' ? 'readwrite' : 'readonly';
  const fingerprint = fingerprintForConfigs();
  const next = {
    mode,
    client: null,
    tools: [],
    byName: new Map(),
    listPayload: { tools: [] },
    sourcePath: cfgWithSource?.path ?? null,
    fingerprint,
  };
  const getClient = () => {
    if (!next.client) next.client = createClient({ mode: next.mode, retries: 2 });
    return next.client;
  };
  next.tools = buildTools({ getClient, mode });
  next.byName = new Map(next.tools.map((t) => [t.name, t]));
  next.listPayload = {
    tools: next.tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
  };
  return next;
}

let state = buildState();

function refreshStateIfChanged() {
  const fingerprint = fingerprintForConfigs();
  if (fingerprint === state.fingerprint) return false;
  const next = buildState();
  const toolsChanged = next.mode !== state.mode;
  state = next;
  return toolsChanged;
}

// ── Xử lý message ───────────────────────────────────────────────────────────

async function handle(msg) {
  const { id, method, params } = msg ?? {};
  if (method !== 'initialize' && refreshStateIfChanged()) await notifyToolsChanged();
  const snapshot = state;

  switch (method) {
    case 'initialize':
      return ok(id, {
        protocolVersion: params?.protocolVersion ?? FALLBACK_PROTOCOL,
        capabilities: { tools: { listChanged: true } },
        serverInfo: SERVER_INFO,
      });

    // Notification: KHÔNG có id, KHÔNG được trả lời.
    case 'notifications/initialized':
    case 'notifications/cancelled':
      return;

    case 'ping':
      return ok(id, {});

    case 'tools/list':
      return ok(id, snapshot.listPayload);

    case 'tools/call': {
      const tool = snapshot.byName.get(params?.name);
      if (!tool) return fail(id, -32602, `Không có tool "${params?.name}".`);
      try {
        const result = await tool.run(params?.arguments ?? {});
        return ok(id, {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        });
      } catch (err) {
        // Lỗi của tool trả về dạng isError để model ĐỌC ĐƯỢC và tự xử lý, thay vì
        // ném lỗi protocol khiến client coi như server hỏng.
        return ok(id, {
          isError: true,
          content: [{ type: 'text', text: explain(err, snapshot) }],
        });
      }
    }

    default:
      // Chỉ trả lỗi cho request (có id); notification lạ thì im lặng bỏ qua.
      if (id !== undefined) fail(id, -32601, `Method không hỗ trợ: ${method}`);
  }
}

/** Thông điệp lỗi hướng người dùng tới hành động tiếp theo, không chỉ báo mã lỗi. */
function explain(err, snapshot = state) {
  const msg = String(err?.message ?? err);
  const code = Number(err?.code);
  const email = snapshot.client?.credentials?.clientEmail;

  if (code === 403 || code === 404) {
    return (
      `${msg}\n\n` +
      'Service account là một danh tính RIÊNG — nó không thấy gì cho tới khi file/thư mục được ' +
      `share cho email của nó${email ? `: ${email}` : ''}. Bảo người dùng Share (Viewer để đọc, ` +
      'Editor để ghi) rồi thử lại. Không có cách vòng nào khác.'
    );
  }
  if (/không tìm thấy credential|CredentialError/i.test(msg)) {
    return `${msg}\n\nChạy /gdrive-setup để cấu hình service account.`;
  }
  if (err?.code === 'NOT_SHARED_DRIVE' || /storageQuotaExceeded/i.test(msg)) {
    return `${msg}\n\nService account không có dung lượng My Drive — đích upload phải là Shared Drive.`;
  }
  return msg;
}

// ── Vòng đọc stdin (JSON-RPC phân cách bằng newline) ────────────────────────

let buffer = '';
const inFlight = new Set();
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let nl;
  while ((nl = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      console.error('[gdrive-mcp] bỏ qua frame không phải JSON');
      continue;
    }
    // Không await: nhiều tool call có thể chạy song song, mỗi cái tự trả theo id.
    const work = Promise.resolve(handle(msg)).catch((err) => {
      console.error('[gdrive-mcp] handler lỗi:', err);
      if (msg?.id !== undefined) return fail(msg.id, -32603, String(err?.message ?? err));
      return undefined;
    });
    inFlight.add(work);
    work.finally(() => inFlight.delete(work));
  }
});
process.stdin.on('end', async () => {
  process.exitCode = 0;
  const forceExit = setTimeout(() => process.exit(0), SHUTDOWN_TIMEOUT_MS);
  forceExit.unref();
  const drain = async () => {
    await Promise.allSettled([...inFlight]);
    await Promise.allSettled([...pendingWrites]);
  };
  await drain();
  // Trên Windows, stdout pipe là kênh ghi bất đồng bộ; process.exit() có thể cắt
  // phần libuv chưa đẩy sang đầu đọc, nhất là Node 18 với frame lớn.
});
