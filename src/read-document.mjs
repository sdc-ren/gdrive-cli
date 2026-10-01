// Đọc "một thứ gì đó trên Drive" — tự nhận định dạng rồi chọn đường xử lý.
//
// Đây là nơi CLI và thư viện chia sẻ logic; bin/cli.mjs chỉ lo parse cờ và in ra.

import { downloadFile, exportFile, getFile } from './drive.mjs';
import { classify, exportMimeFor, KIND } from './formats.mjs';
import { readDocx } from './ooxml-docx.mjs';
import { pptxToText, readPptx } from './ooxml-pptx.mjs';
import { openXlsx } from './ooxml-xlsx.mjs';
import { readSheet } from './sheets.mjs';

export class UnsupportedFormatError extends Error {
  constructor(message, { kind, code = 'UNSUPPORTED' } = {}) {
    super(message);
    this.name = 'UnsupportedFormatError';
    this.kind = kind;
    this.code = code;
  }
}

/** Trên ngưỡng này thì không tải vào RAM để đọc — người dùng tải bằng CLI `gdrive get`. */
export const MAX_DOWNLOAD_BYTES = 50 * 1024 * 1024;

function assertDownloadable(meta) {
  if (Number(meta.size ?? 0) > MAX_DOWNLOAD_BYTES) {
    throw new UnsupportedFormatError(
      `"${meta.name}" nặng ${(Number(meta.size) / 1024 / 1024).toFixed(0)} MB, quá ngưỡng ${MAX_DOWNLOAD_BYTES / 1024 / 1024} MB để đọc thẳng. ` +
        'Tải về bằng: gdrive get <url> --out <file>',
      { kind: KIND.OTHER, code: 'TOO_LARGE' },
    );
  }
}

/** Metadata + phân loại — rẻ, gọi trước khi đoán. */
export async function inspect(client, fileId) {
  const meta = await getFile(client, fileId);
  const info = classify(meta.mimeType, meta.name);
  return { meta, ...info };
}

/**
 * Đọc dữ liệu dạng BẢNG: Google Sheets hoặc .xlsx trên Drive.
 *
 * Việc tự nhận .xlsx ở đây chính là thứ thay thế cả 2 chỗ shell ra python3+openpyxl.
 */
export async function readTable(
  client,
  fileId,
  { sheet = null, gid = null, range = null, maxRows = 500, valueRenderOption = 'FORMATTED_VALUE', meta = null } = {},
) {
  // Có `meta` sẵn (chỗ gọi đã files.get để kiểm phạm vi) thì không gọi lại.
  const picked = meta ? { meta, ...classify(meta.mimeType, meta.name) } : await inspect(client, fileId);
  const { meta: m, kind } = picked;

  if (kind === KIND.GOOGLE_SHEET) {
    const res = await readSheet(client, fileId, { sheet, gid, range, valueRenderOption });
    return finishTable({
      name: m.name,
      source: 'sheets-api',
      title: res.spreadsheetTitle,
      sheet: res.sheet,
      sheets: res.sheets,
      rows: res.rows,
      maxRows,
    });
  }

  if (kind === KIND.XLSX) {
    assertDownloadable(m);
    const wb = openXlsx(await downloadFile(client, fileId));
    const sel = wb.readSheet({ sheet, gid });
    return finishTable({
      name: m.name,
      source: 'xlsx',
      title: m.name,
      sheet: sel.sheet,
      // Kích thước thật chỉ biết sau khi parse từng sheet — điền cho sheet đang đọc.
      sheets: wb.sheets.map((s) => (s.gid === sel.sheet.gid ? sel.sheet : s)),
      rows: sel.rows,
      maxRows,
      warnings: range ? ['Bỏ qua --range: file .xlsx đọc nguyên sheet.'] : [],
    });
  }

  throw new UnsupportedFormatError(
    `"${m.name}" không phải bảng (${m.mimeType}). Dùng \`gdrive doc\` cho văn bản, ` +
      'hoặc `gdrive info` để xem đọc được bằng cách nào.',
    { kind },
  );
}

function finishTable({ name, source, title, sheet, sheets, rows, maxRows, warnings = [] }) {
  const truncated = rows.length > maxRows;
  return {
    name,
    source,
    spreadsheetTitle: title,
    sheet,
    sheets,
    rows: truncated ? rows.slice(0, maxRows) : rows,
    rowCount: rows.length,
    truncated,
    warnings,
  };
}

/**
 * Đọc VĂN BẢN: Google Docs/Slides, .docx/.pptx, hoặc file text thuần.
 * @returns {{name, kind, source, content, slides?, warnings, truncated}}
 */
export async function readDocument(
  client,
  fileId,
  { format = 'markdown', includeNotes = false, maxChars = 100_000, meta = null } = {},
) {
  const picked = meta ? { meta, ...classify(meta.mimeType, meta.name) } : await inspect(client, fileId);
  const { meta: m, kind, note } = picked;

  if (kind === KIND.LEGACY || kind === KIND.PDF || kind === KIND.OTHER || kind === KIND.FOLDER) {
    throw new UnsupportedFormatError(note ?? `Không đọc được "${m.name}" (${m.mimeType}).`, { kind });
  }
  if (kind === KIND.GOOGLE_SHEET || kind === KIND.XLSX) {
    throw new UnsupportedFormatError(
      `"${m.name}" là bảng — dùng \`gdrive read\` thay vì \`gdrive doc\`.`,
      { kind },
    );
  }

  const out = { name: m.name, kind, warnings: [], slides: null };

  if (kind === KIND.GOOGLE_DOC) {
    const buf = await exportFile(client, fileId, exportMimeFor(kind, format));
    out.source = 'export';
    out.content = buf.toString('utf8');
  } else if (kind === KIND.GOOGLE_SLIDES) {
    // Export .pptx rồi tự parse để GIỮ ranh giới slide.
    const buf = await exportFile(client, fileId, exportMimeFor(kind, format));
    const parsed = readPptx(buf, { includeNotes });
    out.source = 'export+ooxml';
    out.slides = parsed.slides;
    out.content = pptxToText(parsed, { format });
    out.warnings.push(...parsed.warnings);
  } else if (kind === KIND.DOCX) {
    assertDownloadable(m);
    const parsed = readDocx(await downloadFile(client, fileId), { format });
    out.source = 'ooxml';
    out.content = parsed.content;
    out.warnings.push(...parsed.warnings);
  } else if (kind === KIND.PPTX) {
    assertDownloadable(m);
    const parsed = readPptx(await downloadFile(client, fileId), { includeNotes });
    out.source = 'ooxml';
    out.slides = parsed.slides;
    out.content = pptxToText(parsed, { format });
    out.warnings.push(...parsed.warnings);
  } else {
    assertDownloadable(m);
    out.source = 'raw';
    out.content = (await downloadFile(client, fileId)).toString('utf8');
  }

  out.charCount = out.content.length;
  out.truncated = out.content.length > maxChars;
  if (out.truncated) {
    out.content = out.content.slice(0, maxChars);
    out.warnings.push(`Đã cắt còn ${maxChars} ký tự (tổng ${out.charCount}). Tăng bằng --max-chars.`);
  }
  return out;
}
