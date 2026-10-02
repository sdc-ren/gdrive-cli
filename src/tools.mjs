// Năm tool MCP, trả VĂN BẢN THUẦN (không bọc JSON) để tiết kiệm token. Người dùng gửi link,
// tool mở thẳng link đó; quyền theo share trên Drive (access.mjs): Editor ghi được, Viewer chỉ
// đọc. Không tool nào đụng tới hệ thống file của máy.

import { AccessError, createAccess } from './access.mjs';
import { createFolder, listFiles, updateFile, uploadFile } from './drive.mjs';
import { classify, KIND, MIME } from './formats.mjs';
import { createMetaStore } from './meta.mjs';
import { readDocument, readTable } from './read-document.mjs';
import { renderDoc, renderLs, renderTable } from './render.mjs';
import { assertSafeCellValue, assertSafeTable } from './sheet-guard.mjs';
import { appendValues, batchUpdateValues, getValues, pickSheet } from './sheets.mjs';
import { viewTable } from './table-view.mjs';
import { buildA1 } from './url.mjs';

const target = { type: 'string', description: 'Google URL or id.' };

function tsvToCsv(text) {
  if (!text.includes('\t')) return text;
  const q = (c) => (/[",\r\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c);
  return text.split(/\r?\n/).map((line) => line.split('\t').map(q).join(',')).join('\n');
}

/**
 * @param {object} ctx
 * @param {() => object} ctx.getClient   client đã dựng (lazy, cache ở server)
 * @param {'readonly'|'readwrite'} ctx.mode  khoá an toàn chung; readonly thì ẩn tool ghi
 */
export function buildTools({ getClient, mode = 'readwrite', now = Date.now }) {
  let meta = null;
  let access = null;
  const ctx = () => {
    const client = getClient();
    meta ??= createMetaStore({ client, now });
    access ??= createAccess({ meta, mode });
    return { client, meta, access };
  };

  async function readSheetLike({ client, meta }, m, args, gid) {
    const kind = classify(m.mimeType, m.name).kind;
    let tab, tabs, rows;
    if (kind === KIND.GOOGLE_SHEET) {
      const sm = await meta.sheet(m.id);
      tab = pickSheet(sm.sheets, { sheet: args.sheet ?? null, gid });
      tabs = sm.sheets.map((s) => s.title);
      rows = await getValues(client, m.id, buildA1(tab.title, null));
    } else {
      const res = await readTable(client, m.id, { meta: m, sheet: args.sheet ?? null, gid, maxRows: Number.MAX_SAFE_INTEGER });
      tab = res.sheet;
      tabs = res.sheets.map((s) => s.title);
      rows = res.rows;
    }
    const view = viewTable(rows, { columns: args.columns ?? null, where: args.where ?? null, offset: args.offset ?? 0, limit: args.limit ?? 200 });
    return renderTable({ file: m.name, tab: tab.title, tabs, view });
  }

  const all = [
    {
      name: 'drive_ls',
      write: false,
      description: 'List a folder\'s contents (folder URL or id), one line per item.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { ...target, description: 'Folder URL or id.' },
          query: { type: 'string', description: 'Name contains.' },
          limit: { type: 'integer', description: 'Default 30, max 200.' },
          page: { type: 'string', description: 'next token.' },
        },
        required: ['path'],
        additionalProperties: false,
      },
      async run(args) {
        const { client, access } = ctx();
        const { fileId, meta: m } = await access.resolve(args.path);
        if (m.mimeType !== MIME.FOLDER) throw new AccessError('NOT_FOUND', `"${m.name}" không phải folder. Dùng drive_read để đọc.`);
        const max = Math.min(Math.max(Number(args.limit) || 30, 1), 200);
        const { files, nextPageToken } = await listFiles(client, { folderId: fileId, nameContains: args.query ?? null, max, pageToken: args.page ?? null });
        return renderLs({ title: m.name, access: access.accessOf(m), items: files, total: files.length, next: nextPageToken });
      },
    },

    {
      name: 'drive_read',
      write: false,
      description: 'Read a file: sheets/xlsx as TSV (filter, paged), docs/slides/text as markdown.',
      inputSchema: {
        type: 'object',
        properties: {
          target,
          sheet: { type: 'string', description: 'Tab name or gid.' },
          columns: { type: 'array', items: { type: 'string' }, description: 'Header names to keep.' },
          where: { type: 'object', additionalProperties: { type: 'string' }, description: 'Exact match per column (AND).' },
          offset: { type: 'integer' },
          limit: { type: 'integer', description: 'Default 200, max 2000.' },
          max_chars: { type: 'integer', description: 'Default 20000.' },
        },
        required: ['target'],
        additionalProperties: false,
      },
      async run(args) {
        const c = ctx();
        const { meta: m, gid } = await c.access.resolve(args.target);
        const { kind, note } = classify(m.mimeType, m.name);
        if (kind === KIND.GOOGLE_SHEET || kind === KIND.XLSX) return readSheetLike(c, m, args, gid);
        if (kind === KIND.FOLDER) return `# ${m.name} · folder · dùng drive_ls để liệt kê`;
        if ([KIND.GOOGLE_DOC, KIND.GOOGLE_SLIDES, KIND.DOCX, KIND.PPTX, KIND.TEXT].includes(kind)) {
          const maxChars = Math.max(Number(args.max_chars) || 20_000, 1);
          const res = await readDocument(c.client, m.id, { meta: m, maxChars });
          const text = res.warnings.length ? `${res.content}\n# warnings: ${res.warnings.join(' | ')}` : res.content;
          return renderDoc({ file: m.name, kind, text, total: res.charCount, truncatedAt: res.truncated ? maxChars : null });
        }
        return `# ${m.name} · ${m.mimeType}${m.size ? ` · ${m.size} bytes` : ''} · không trích được chữ${note ? `. ${note.split('\n')[0]}` : ''}. Tải về bằng CLI: gdrive get`;
      },
    },

    {
      name: 'sheet_write',
      write: true,
      description: 'Write cells {"L5":"PASS"} and/or append rows to a Google Sheet (needs Editor).',
      inputSchema: {
        type: 'object',
        properties: {
          target,
          sheet: { type: 'string', description: 'Tab name or gid.' },
          cells: { type: 'object', additionalProperties: { type: 'string' } },
          append: { type: 'array', items: { type: 'array', items: { type: 'string' } } },
        },
        required: ['target'],
        additionalProperties: false,
      },
      async run(args) {
        const cells = Object.entries(args.cells ?? {});
        const rows = Array.isArray(args.append) ? args.append : [];
        if (!cells.length && !rows.length) throw new Error('Cần cells hoặc append — không có gì để ghi.');
        for (const [, v] of cells) assertSafeCellValue(v);
        for (const r of rows) for (const v of r) assertSafeCellValue(v);
        const { client, meta, access } = ctx();
        const { fileId, gid, meta: m } = await access.resolve(args.target);
        await access.ensureCanEdit(m);
        if (m.mimeType !== MIME.GOOGLE_SHEET) throw new Error(`"${m.name}" không phải Google Sheet — chỉ ghi được vào Google Sheet.`);
        const sm = await meta.sheet(fileId);
        const tab = pickSheet(sm.sheets, { sheet: args.sheet ?? null, gid });
        let wrote = 0;
        if (cells.length) {
          const res = await batchUpdateValues(client, fileId, cells.map(([cell, value]) => ({ range: buildA1(tab.title, cell), values: [[String(value)]] })));
          wrote = res.updatedCells;
        }
        if (rows.length) await appendValues(client, fileId, buildA1(tab.title, null), rows.map((r) => r.map((v) => String(v ?? ''))));
        meta.invalidate(fileId);
        return `✓ ${tab.title}: ${wrote} cells, +${rows.length} rows`;
      },
    },

    {
      name: 'drive_create',
      write: true,
      description: 'Create a folder, Google Doc (markdown) or Google Sheet (CSV/TSV) in a folder (needs Editor).',
      inputSchema: {
        type: 'object',
        properties: {
          parent: target,
          name: { type: 'string' },
          kind: { type: 'string', enum: ['folder', 'doc', 'sheet'] },
          content: { type: 'string' },
        },
        required: ['parent', 'name', 'kind'],
        additionalProperties: false,
      },
      async run(args) {
        if (!['folder', 'doc', 'sheet'].includes(args.kind)) throw new Error('kind phải là folder, doc hoặc sheet.');
        if (!String(args.name ?? '').trim()) throw new Error('name không được rỗng.');
        if (args.kind === 'sheet') assertSafeTable(args.content);
        const { client, meta, access } = ctx();
        const { fileId: parentId, meta: pm } = await access.resolve(args.parent);
        if (pm.mimeType !== MIME.FOLDER) throw new Error(`"${pm.name}" không phải folder.`);
        await access.ensureCanAddChildren(pm);
        // Service account không có dung lượng My Drive: tạo Doc/Sheet chỉ được trên Shared Drive
        // (đo thật 2026-10-01: folder thì tạo được, Doc/Sheet bị 403 storageQuotaExceeded).
        if (args.kind !== 'folder' && !pm.driveId) {
          throw new Error(`Không tạo được ${args.kind} trong "${pm.name}": folder nằm trên My Drive, service account không có dung lượng. Dùng folder trên Shared Drive, hoặc người dùng tự tạo file rồi share.`);
        }
        let file;
        if (args.kind === 'folder') {
          file = await createFolder(client, { name: args.name, parentId });
        } else {
          const isDoc = args.kind === 'doc';
          file = await uploadFile(client, {
            name: args.name,
            folderId: parentId,
            content: isDoc ? String(args.content ?? '') : tsvToCsv(String(args.content ?? '')),
            mimeType: isDoc ? 'text/markdown' : 'text/csv',
            convertTo: isDoc ? MIME.GOOGLE_DOC : MIME.GOOGLE_SHEET,
          });
        }
        meta.invalidate(parentId);
        return `✓ ${args.kind} ${args.name} ${file.id}${file.webViewLink ? ` ${file.webViewLink}` : ''}`;
      },
    },

    {
      name: 'drive_move',
      write: true,
      description: 'Rename a file and/or move it to another folder (needs Editor).',
      inputSchema: {
        type: 'object',
        properties: {
          target,
          new_name: { type: 'string' },
          to: { ...target, description: 'Destination folder URL or id.' },
        },
        required: ['target'],
        additionalProperties: false,
      },
      async run(args) {
        if (!args.new_name && !args.to) throw new Error('Cần new_name hoặc to.');
        const { client, meta, access } = ctx();
        const { fileId, meta: m } = await access.resolve(args.target);
        await access.ensureCanEdit(m);
        let dest = null;
        if (args.to) {
          const r = await access.resolve(args.to);
          if (r.meta.mimeType !== MIME.FOLDER) throw new Error(`"${r.meta.name}" không phải folder.`);
          await access.ensureCanAddChildren(r.meta);
          dest = r;
        }
        let removeParents = null;
        if (dest) {
          // parents trong cache có thể cũ (5 phút): lấy lại, nếu không file có thể nằm ở 2 folder.
          meta.invalidate(fileId);
          const fresh = await meta.file(fileId);
          if (!fresh.parents?.length) throw new Error(`Không xác định được folder hiện tại của "${m.name}" — không di chuyển.`);
          removeParents = fresh.parents.filter((p) => p !== dest.fileId).join(',') || null;
        }
        await updateFile(client, fileId, { name: args.new_name ?? null, addParents: dest?.fileId ?? null, removeParents });
        meta.invalidate(fileId);
        return `✓ ${args.new_name ?? m.name}${dest ? ` → ${dest.meta.name}` : ''}`;
      },
    },
  ];

  return mode === 'readwrite' ? all : all.filter((t) => !t.write);
}
