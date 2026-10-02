#!/usr/bin/env node
// gdrive — đọc/ghi Google Drive, Sheets, Docs, Slides bằng service account.
//
// stdout = kết quả, stderr = chẩn đoán/lỗi, exit code ≠ 0 khi hỏng — để chỗ gọi (client AI,
// script) phân biệt được.

import { realpathSync, statSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { pathToFileURL } from 'node:url';

import { runClientUninstall, runInstall } from '../src/clients.mjs';
import { resolveCliMode } from '../src/cli-scope.mjs';
import { createClient } from '../src/client.mjs';
import { readConfig } from '../src/config.mjs';
import {
  assertUploadableFolder,
  downloadFile,
  exportFile,
  listFiles,
  shareFile,
  uploadFile,
} from '../src/drive.mjs';
import { KIND as FORMAT_KIND, MIME } from '../src/formats.mjs';
import { runInit } from '../src/init.mjs';
import { assertSafeCellValue } from '../src/sheet-guard.mjs';
import { batchUpdateValues, getMetadata, pickSheet } from '../src/sheets.mjs';
import { runStatus } from '../src/status.mjs';
import { runUninstall } from '../src/uninstall.mjs';
import { inspect, readDocument, readTable } from '../src/read-document.mjs';
import { buildA1, parseGoogleUrl } from '../src/url.mjs';

const VALUE_FLAGS = new Set([
  'sheet', 'range', 'max-rows', 'max-chars', 'format', 'out', 'folder', 'name-contains',
  'mime-type', 'query', 'max', 'set', 'share', 'name', 'sa-json', 'mode', 'client', 'access',
]);
const REPEATABLE_FLAGS = new Set(['set']);

export function parseArgs(argv) {
  const flags = { _: [] };
  const set = (key, value) => {
    if (!REPEATABLE_FLAGS.has(key) || flags[key] == null) flags[key] = value;
    else flags[key] = [].concat(flags[key], value);
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      flags._.push(arg);
      continue;
    }
    const eq = arg.indexOf('=');
    if (eq > 2) {
      set(arg.slice(2, eq), arg.slice(eq + 1));
    } else {
      const key = arg.slice(2);
      if (VALUE_FLAGS.has(key) && argv[i + 1] != null && !argv[i + 1].startsWith('--')) {
        set(key, argv[++i]);
      } else {
        set(key, true);
      }
    }
  }
  return flags;
}

const HELP = `gdrive — Google Drive / Sheets / Docs / Slides bằng service account

  gdrive read <url> [--sheet <tên|gid>] [--range A1:E50] [--max-rows 500] [--json]
        Đọc bảng: Google Sheets hoặc .xlsx trên Drive (tự nhận, không cần python).

  gdrive doc <url> [--format markdown|text] [--notes] [--max-chars 100000] [--json]
        Đọc văn bản: Google Docs/Slides, .docx, .pptx, .csv, .txt, .md.

  gdrive info <url> [--json]
        File này là gì và đọc được bằng lệnh nào.

  gdrive ls [<url-thư-mục>] [--name-contains <chuỗi>] [--mime-type <mime>] [--max 50] [--json]
  gdrive get <url> --out <đường-dẫn>
  gdrive put <file> --folder <url> [--name <tên>] [--share none|anyone-reader]
  gdrive write <url> --set <ô>=<giá trị> [--set …] [--sheet <tên|gid>]

  gdrive init [--sa-json <file>|--adc] [--mode readonly|readwrite] [--yes] [--no-test] [--no-skill]
  gdrive status
  gdrive uninstall [--purge]

  gdrive install --client <codex|copilot|copilot-cli|cursor|kiro>[,…] [--project] [--skill]
        Đăng ký MCP server vào client AI (mặc định cấp user; --project ghi vào repo đang
        đứng). --skill cài kèm Agent Skill hướng dẫn dùng tool.
  gdrive uninstall --client <tên>[,…] [--project]
        Gỡ đăng ký khỏi client, không đụng credential.

  gdrive mcp
        Chạy MCP server (stdio) — trỏ Codex, Copilot, Cursor, Kiro… vào lệnh này.

Ghi chú:
  • Mọi lệnh nhận thẳng URL dán vào — tự bóc file id và gid.
  • --json in dữ liệu máy đọc; không có thì in bảng cho người đọc.
  • Chế độ readonly (mặc định) từ chối write/put ngay tại chỗ.
`;

// ── In ra ────────────────────────────────────────────────────────────────────

const CELL_MAX = 40;

function renderTable(rows) {
  if (!rows.length) return '(không có dữ liệu)';
  const width = Math.max(...rows.map((r) => r.length));
  const cells = rows.map((r) =>
    Array.from({ length: width }, (_, i) => {
      const v = String(r[i] ?? '').replace(/\s+/g, ' ');
      return v.length > CELL_MAX ? `${v.slice(0, CELL_MAX - 1)}…` : v;
    }),
  );
  const colWidth = Array.from({ length: width }, (_, i) =>
    Math.max(1, ...cells.map((r) => [...r[i]].length)),
  );
  const gutter = String(cells.length).length;
  return cells
    .map(
      (r, n) =>
        `${String(n + 1).padStart(gutter)} │ ` +
        r.map((v, i) => v + ' '.repeat(Math.max(0, colWidth[i] - [...v].length))).join(' │ ').trimEnd(),
    )
    .join('\n');
}

const out = (s) => process.stdout.write(`${s}\n`);
const err = (s) => process.stderr.write(`${s}\n`);
const json = (o) => out(JSON.stringify(o, null, 2));

function printWarnings(warnings) {
  for (const w of warnings ?? []) err(`⚠️  ${w}`);
}

// ── Client ───────────────────────────────────────────────────────────────────

function clientFor(flags, { needWrite = false } = {}) {
  const mode = resolveCliMode({ flags, cfg: readConfig(), needWrite });
  return createClient({ mode, retries: 2 });
}

/** CLI nhận URL hoặc id; quyền do Drive quyết định. Giữ tên cũ để không sửa chỗ gọi. */
async function scopedTarget(_client, input) {
  return parseGoogleUrl(input);
}

function requireArg(flags, index, what) {
  const v = flags._[index];
  if (!v) {
    const e = new Error(`Thiếu ${what}.\n\n${HELP}`);
    e.exitCode = 2;
    throw e;
  }
  return v;
}

// ── Lệnh ─────────────────────────────────────────────────────────────────────

async function cmdRead(flags) {
  const client = clientFor(flags);
  const { id, gid } = await scopedTarget(client, requireArg(flags, 1, '<url>'));
  const res = await readTable(client, id, {
    sheet: flags.sheet ?? null,
    gid,
    range: flags.range ?? null,
    maxRows: Number(flags['max-rows'] ?? 500),
  });

  if (flags.json) {
    json(res);
    return true;
  }

  out(`📄 ${res.spreadsheetTitle ?? res.name}   [${res.source}]`);
  out(`   Tab: "${res.sheet.title}" (gid=${res.sheet.gid})   ${res.rowCount} hàng`);
  if (res.sheets.length > 1) {
    out(`   Các tab khác: ${res.sheets.filter((s) => s.gid !== res.sheet.gid).map((s) => `${s.title} (gid=${s.gid})`).join(', ')}`);
  }
  out('');
  out(renderTable(res.rows));
  if (res.truncated) err(`⚠️  Mới hiện ${res.rows.length}/${res.rowCount} hàng — tăng bằng --max-rows.`);
  printWarnings(res.warnings);
  return true;
}

async function cmdDoc(flags) {
  const client = clientFor(flags);
  const { id } = await scopedTarget(client, requireArg(flags, 1, '<url>'));
  const res = await readDocument(client, id, {
    format: flags.format === 'text' ? 'text' : 'markdown',
    includeNotes: flags.notes === true,
    maxChars: Number(flags['max-chars'] ?? 100_000),
  });

  if (flags.json) {
    json(res);
    return true;
  }
  err(`📄 ${res.name}   [${res.kind} · ${res.source}]   ${res.charCount} ký tự`);
  printWarnings(res.warnings);
  out(res.content);
  return true;
}

async function cmdInfo(flags) {
  const client = clientFor(flags);
  const { id } = await scopedTarget(client, requireArg(flags, 1, '<url>'));
  const { meta, kind, readAs, tabular, note } = await inspect(client, id);

  const payload = {
    id: meta.id,
    name: meta.name,
    mimeType: meta.mimeType,
    kind,
    readAs,
    tabular,
    size: meta.size ? Number(meta.size) : null,
    modifiedTime: meta.modifiedTime,
    webViewLink: meta.webViewLink,
    driveId: meta.driveId ?? null,
    onSharedDrive: Boolean(meta.driveId),
    note,
  };
  if (flags.json) {
    json(payload);
    return true;
  }

  out(`📄 ${meta.name}`);
  out(`   kind        : ${kind}${tabular ? ' (dạng bảng)' : ''}`);
  out(`   mimeType    : ${meta.mimeType}`);
  out(`   đọc bằng    : ${readAs.length ? readAs.map((c) => `gdrive ${c}`).join(' | ') : '(không đọc được)'}`);
  out(`   sửa lần cuối: ${meta.modifiedTime ?? '?'}`);
  out(`   nơi lưu     : ${meta.driveId ? `Shared Drive (${meta.driveId})` : 'My Drive'}`);
  if (meta.webViewLink) out(`   link        : ${meta.webViewLink}`);
  if (note) out(`\n${note}`);
  return kind !== FORMAT_KIND.LEGACY;
}

async function cmdLs(flags) {
  const target = flags._[1];
  const client = clientFor(flags);
  const folderId = target ? parseGoogleUrl(target).id : null;
  const { files, nextPageToken } = await listFiles(client, {
    folderId,
    nameContains: flags['name-contains'] ?? null,
    mimeType: flags['mime-type'] ?? null,
    query: flags.query ?? null,
    max: Number(flags.max ?? 50),
  });

  if (flags.json) {
    json({ files, nextPageToken });
    return true;
  }
  if (!files.length) {
    out('(không có file nào — nhớ là service account chỉ thấy thứ đã được share cho nó)');
    return true;
  }
  for (const f of files) {
    const size = f.size ? `${(Number(f.size) / 1024).toFixed(0)}K`.padStart(6) : '     -';
    out(`${size}  ${(f.modifiedTime ?? '').slice(0, 10)}  ${f.id}  ${f.name}`);
  }
  if (nextPageToken) err(`⚠️  Còn nữa — tăng --max để lấy thêm.`);
  return true;
}

async function cmdGet(flags) {
  const input = requireArg(flags, 1, '<url>');
  const dest = flags.out;
  if (!dest) {
    const e = new Error('Thiếu --out <đường-dẫn>.');
    e.exitCode = 2;
    throw e;
  }
  const client = clientFor(flags);
  const { id } = await scopedTarget(client, input);
  const { meta, kind } = await inspect(client, id);

  // File native của Google không tải thẳng được — phải export.
  const exportAs = {
    [FORMAT_KIND.GOOGLE_DOC]: MIME.PDF,
    [FORMAT_KIND.GOOGLE_SHEET]: MIME.XLSX,
    [FORMAT_KIND.GOOGLE_SLIDES]: MIME.PPTX,
  }[kind];

  // CLI: người dùng ngồi chờ được bao lâu cũng được → không timeout (file lớn, mạng chậm).
  const buf = exportAs ? await exportFile(client, id, exportAs, { timeoutMs: 0 }) : await downloadFile(client, id, { timeoutMs: 0 });
  writeFileSync(dest, buf);

  const payload = { path: dest, bytes: buf.length, name: meta.name, exported: Boolean(exportAs), mimeType: exportAs ?? meta.mimeType };
  if (flags.json) json(payload);
  else out(`✅ ${meta.name} → ${dest} (${(buf.length / 1024).toFixed(0)} KB${exportAs ? `, export sang ${exportAs}` : ''})`);
  return true;
}

async function cmdPut(flags) {
  const src = requireArg(flags, 1, '<file>');
  if (!flags.folder) {
    const e = new Error('Thiếu --folder <url-thư-mục>.');
    e.exitCode = 2;
    throw e;
  }
  const client = clientFor(flags, { needWrite: true });
  const folderId = (await scopedTarget(client, flags.folder, { write: true })).id;

  // Chặn trước bằng lỗi nói đúng bệnh, thay vì để Google ném 403 khó hiểu.
  await assertUploadableFolder(client, folderId);

  const content = await import('node:fs').then((fs) => fs.readFileSync(src));
  statSync(src);
  const file = await uploadFile(client, {
    name: flags.name ?? basename(src),
    folderId,
    content,
  });

  // Chia sẻ công khai LUÔN phải là lựa chọn tường minh.
  if (flags.share === 'anyone-reader') {
    await shareFile(client, file.id, { role: 'reader', type: 'anyone' });
  }

  if (flags.json) json({ ...file, shared: flags.share ?? 'none' });
  else out(`✅ ${file.name} → ${file.webViewLink ?? file.id}${flags.share === 'anyone-reader' ? ' (ai có link cũng xem được)' : ''}`);
  return true;
}

/** `--set Ô=giá trị` (lặp được) → [{ cell, value }]. Sai cách dùng → exitCode 2. */
export function parseSets(flags) {
  const sets = [].concat(flags.set ?? []).filter((s) => typeof s === 'string');
  if (!sets.length) {
    const e = new Error('Thiếu --set <ô>=<giá trị>. Ví dụ: --set L5=PASSED --set L6=FAILED');
    e.exitCode = 2;
    throw e;
  }
  return sets.map((entry) => {
    const eq = entry.indexOf('=');
    if (eq < 1) throw Object.assign(new Error(`--set "${entry}" sai cú pháp, cần dạng Ô=giá trị.`), { exitCode: 2 });
    const value = entry.slice(eq + 1);
    // Cùng luật với MCP: muốn công thức IMPORT*/IMAGE thật thì gõ trong giao diện Sheets.
    try {
      assertSafeCellValue(value);
    } catch (err) {
      throw Object.assign(err, { exitCode: 2 });
    }
    return { cell: entry.slice(0, eq).trim(), value };
  });
}

async function cmdWrite(flags) {
  // Kiểm cú pháp TRƯỚC khi dựng client: lỗi cách dùng không được tốn một vòng gọi mạng.
  const input = requireArg(flags, 1, '<url>');
  const sets = parseSets(flags);
  const client = clientFor(flags, { needWrite: true });
  const { id, gid } = await scopedTarget(client, input, { write: true });

  const meta = await getMetadata(client, id);
  const sheet = pickSheet(meta.sheets, { sheet: flags.sheet ?? null, gid });

  // buildA1 lo phần tên tab + dấu nháy — chỗ 8 bản fork trong packflow đều viết sai.
  const data = sets.map(({ cell, value }) => ({ range: buildA1(sheet.title, cell), values: [[value]] }));

  const res = await batchUpdateValues(client, id, data);
  if (flags.json) json({ sheet, ...res });
  else {
    out(`✅ Đã ghi ${res.updatedCells} ô vào "${sheet.title}" (gid=${sheet.gid})`);
    for (const r of res.updatedRanges) out(`   ${r}`);
  }
  return true;
}

// ── main ─────────────────────────────────────────────────────────────────────

async function main() {
  const flags = parseArgs(process.argv.slice(2));
  const command = flags._[0] || 'help';

  if (flags.version) {
    const { createRequire } = await import('node:module');
    out(createRequire(import.meta.url)('../package.json').version);
    return true;
  }
  if (flags.help || command === 'help') {
    out(HELP);
    return true;
  }

  switch (command) {
    case 'read': return cmdRead(flags);
    case 'doc': return cmdDoc(flags);
    case 'info': return cmdInfo(flags);
    case 'ls': return cmdLs(flags);
    case 'get': return cmdGet(flags);
    case 'put': return cmdPut(flags);
    case 'write': return cmdWrite(flags);
    case 'folder': {
      const e = new Error('Lệnh "folder" đã bỏ ở v0.5.0: quyền lấy theo share trên Drive.');
      e.exitCode = 2;
      throw e;
    }
    case 'init': return runInit(flags);
    case 'status': return runStatus({});
    case 'install': return runInstall(flags, { hasConfig: Boolean(readConfig()) });
    case 'uninstall': return flags.client ? runClientUninstall(flags) : runUninstall(flags);
    case 'mcp':
      // Server tự lo vòng đời: đóng stdin thì drain rồi tự thoát. main KHÔNG được resolve,
      // không thì process.exit bên dưới giết server ngay sau handshake.
      await import('../server/index.mjs');
      return new Promise(() => {});
    default:
      err(`Không biết lệnh "${command}".\n\n${HELP}`);
      return false;
  }
}

// npx chạy bin qua symlink trong .bin → phải realpath trước khi so với import.meta.url,
// không thì guard tưởng file đang bị import và CLI im lặng không làm gì.
let isMain = false;
try {
  isMain = process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
} catch {
  isMain = false;
}
if (isMain) {
  main()
    .then((ok) => process.exit(ok === false ? 1 : 0))
    .catch((e) => {
      err(`❌ ${e.message}`);
      // 2 = sai cách dùng, 3 = bị chặn bởi chế độ, 4 = lỗi từ Google, 1 = còn lại.
      process.exit(e.exitCode ?? (Number.isFinite(Number(e.code)) ? 4 : 1));
    });
}
