// Lọc cột/dòng và phân trang trên mảng rows (dòng đầu là header). Chạy phía server để
// chỉ phần cần đọc đi vào context của model.

export const DEFAULT_LIMIT = 200;
export const MAX_LIMIT = 2000;

export class ViewError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ViewError';
    this.code = 'BAD_COLUMN';
  }
}

const cell = (row, i) => (row[i] === undefined || row[i] === null ? '' : String(row[i]));

function clamp(n, lo, hi) {
  const v = Number.isFinite(Number(n)) ? Math.trunc(Number(n)) : lo;
  return Math.min(Math.max(v, lo), hi);
}

/** Vị trí cột theo tên: khớp chính xác trước, rồi không phân biệt hoa thường; trùng tên lấy cột đầu. */
function columnIndex(header, name) {
  let i = header.indexOf(name);
  if (i < 0) i = header.findIndex((h) => String(h).toLowerCase() === String(name).toLowerCase());
  if (i < 0) throw new ViewError(`Không có cột "${name}". Header: ${header.join(' | ')}`);
  return i;
}

export function viewTable(rows, { columns = null, where = null, offset = 0, limit = DEFAULT_LIMIT } = {}) {
  const header = (rows[0] ?? []).map((h) => cell([h], 0));
  let body = rows.slice(1);

  if (where && Object.keys(where).length) {
    const conds = Object.entries(where).map(([name, value]) => [columnIndex(header, name), String(value).trim()]);
    body = body.filter((row) => conds.every(([i, value]) => cell(row, i).trim() === value));
  }

  const lim = clamp(limit, 1, MAX_LIMIT);
  const off = clamp(offset, 0, Number.MAX_SAFE_INTEGER);
  const total = body.length;
  let page = body.slice(off, off + lim);
  let outHeader = header;

  if (columns && columns.length) {
    const idx = columns.map((name) => columnIndex(header, name));
    outHeader = idx.map((i) => header[i]);
    page = page.map((row) => idx.map((i) => cell(row, i)));
  }

  return { header: outHeader, rows: page, total, offset: off, limit: lim, next: off + lim < total ? off + lim : null };
}

const clean = (s) => String(s ?? '').replace(/[\t\r\n]+/g, ' ');

export function toTsv(header, rows) {
  const width = header.length;
  const line = (row) => Array.from({ length: Math.max(width, row.length) }, (_, i) => clean(row[i] ?? '')).join('\t');
  return [line(header), ...rows.map(line)].join('\n');
}
