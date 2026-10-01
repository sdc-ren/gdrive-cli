// Định dạng kết quả tool thành văn bản thuần, không bọc JSON. Mỗi dòng đầu bắt đầu bằng `#`
// mô tả ngữ cảnh; lỗi bắt đầu bằng `✗`.

import { MIME } from './formats.mjs';
import { toTsv } from './table-view.mjs';

const CODE_BY_MIME = {
  [MIME.FOLDER]: 'd',
  [MIME.GOOGLE_SHEET]: 's',
  [MIME.GOOGLE_DOC]: 'c',
  [MIME.GOOGLE_SLIDES]: 'p',
  [MIME.XLSX]: 'x',
  [MIME.XLSM]: 'x',
  [MIME.DOCX]: 'w',
  [MIME.PPTX]: 'k',
  [MIME.CSV]: 't',
  [MIME.PLAIN]: 't',
  [MIME.MARKDOWN]: 't',
};
const CODE_BY_EXT = { xlsx: 'x', xlsm: 'x', docx: 'w', pptx: 'k', csv: 't', txt: 't', md: 't', json: 't' };

export function typeCode(mimeType, name = '') {
  if (CODE_BY_MIME[mimeType]) return CODE_BY_MIME[mimeType];
  if (/^text\//.test(mimeType ?? '')) return 't';
  const ext = String(name).toLowerCase().split('.').pop();
  return CODE_BY_EXT[ext] ?? 'f';
}

function sizeLabel(size) {
  const n = Number(size);
  if (!Number.isFinite(n) || n <= 0) return null;
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)}KB`;
  return `${(n / 1024 / 1024).toFixed(1)}MB`;
}

export function renderFolders(folders) {
  const lines = folders.map((f) => `d ${f.name} (${f.access}) ${f.id}`);
  return [`# ${folders.length} folders`, ...lines].join('\n');
}

export function renderLs({ title, access, items, total, next = null }) {
  const head = `# ${title} (${access}) · ${total}${next ? ` · next=${next}` : ''}`;
  const lines = items.map((f) => {
    const parts = [typeCode(f.mimeType, f.name), f.name, f.id];
    if (f.modifiedTime) parts.push(String(f.modifiedTime).slice(0, 10));
    const size = sizeLabel(f.size);
    if (size) parts.push(size);
    return parts.join(' ');
  });
  return [head, ...lines].join('\n');
}

export function renderTable({ file, tab, tabs, view }) {
  const from = view.rows.length ? view.offset + 1 : 0;
  const to = view.offset + view.rows.length;
  const range = view.rows.length ? `rows ${from}-${to}/${view.total}` : `rows 0/${view.total}`;
  const head = `# ${file} › ${tab} · tabs: ${tabs.join(',')} · ${range}${view.next !== null ? ` · next=${view.next}` : ''}`;
  return `${head}\n${toTsv(view.header, view.rows)}`;
}

export function renderDoc({ file, kind, text, total, truncatedAt = null }) {
  const lines = [`# ${file} (${kind}) · ${total} chars`, text];
  if (truncatedAt !== null) lines.push(`# truncated at ${truncatedAt}/${total} chars`);
  return lines.join('\n');
}

export function renderError(err, { email = null } = {}) {
  const msg = String(err?.message ?? err).split('\n')[0];
  const code = Number(err?.code);
  if (err?.name === 'ScopeError') return `✗ ${msg}`;
  if (code === 403 || code === 404) {
    return `✗ ${code}: chưa share cho ${email ?? 'service account'} (Viewer để đọc, Editor để ghi). ${msg}`;
  }
  return `✗ ${msg}`;
}
