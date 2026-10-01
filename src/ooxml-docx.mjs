// Đọc .docx → text/markdown.
//
// Phạm vi CỐ Ý hẹp: chỉ word/document.xml. Header/footer/footnote/endnote nằm ở part khác
// và KHÔNG được trích — trả về trong `warnings` thay vì im lặng bỏ qua.

import { decodeEntities, dropAlternateFallback, forEachElement, nsTag } from './xml.mjs';
import { openZip, ZipError } from './zip.mjs';

// Tiền tố namespace không cố định (Word ghi `w:`, thư viện khác ghi khác) → luôn khớp qua
// nsTag, đừng hardcode `w:`.
const T = nsTag('t');
const TAB = nsTag('tab');
const BR = nsTag('br');
const CR = nsTag('cr');

const RUN_RE = new RegExp(
  `<${T}(?:\\s[^>]*)?>([\\s\\S]*?)</${T}>|<${T}\\s*/>|<${TAB}\\s*/>|<${BR}(?:\\s[^>]*)?/>|<${CR}\\s*/>`,
  'g',
);
const INSTR_RE = new RegExp(`<${nsTag('instrText')}[\\s\\S]*?</${nsTag('instrText')}>`, 'g');
const DEL_RE = new RegExp(`<${nsTag('delText')}[\\s\\S]*?</${nsTag('delText')}>`, 'g');
const TAB_HEAD = new RegExp(`^<${TAB}`);
const BREAK_HEAD = new RegExp(`^<(?:${BR}|${CR})`);

/** Text trong một <w:p> hoặc một <w:tc>, đã xử lý tab/xuống dòng mềm. */
function runsToText(xml) {
  let out = '';
  // <w:instrText> là mã field (MERGEFIELD, HYPERLINK…), <w:delText> là chữ ĐÃ XOÁ trong
  // tracked changes — cả hai đều không phải nội dung người đọc thấy.
  const cleaned = xml.replace(INSTR_RE, '').replace(DEL_RE, '');

  // Quét tuần tự để giữ đúng thứ tự giữa chữ, tab và ngắt dòng.
  RUN_RE.lastIndex = 0;
  let m;
  while ((m = RUN_RE.exec(cleaned))) {
    if (m[1] !== undefined) out += decodeEntities(m[1]);
    else if (TAB_HEAD.test(m[0])) out += '\t';
    else if (BREAK_HEAD.test(m[0])) out += '\n';
  }
  return out;
}

const PSTYLE_RE = new RegExp(`<${nsTag('pStyle')}\\s[^>]*?(?:[\\w.-]+:)?val="([^"]*)"`);

function headingLevel(paragraphXml) {
  const m = PSTYLE_RE.exec(paragraphXml);
  if (!m) return 0;
  const style = m[1];
  const heading = /^Heading(\d)$/i.exec(style) ?? /^Ti(?:tle)$/i.exec(style);
  if (!heading) return 0;
  return heading[1] ? Number(heading[1]) : 1;
}

/** Bảng → markdown pipe. Không cố dựng lại merge cell — cột gộp sẽ lặp nội dung. */
function tableToMarkdown(tableXml) {
  const rows = [];
  forEachElement(tableXml, 'w:tr', ({ inner: tr }) => {
    const cells = [];
    forEachElement(tr, 'w:tc', ({ inner: tc }) => {
      const parts = [];
      forEachElement(tc, 'w:p', ({ inner: p }) => parts.push(runsToText(p)));
      cells.push(parts.join(' ').replace(/\s*\n\s*/g, ' ').replace(/\|/g, '\\|').trim());
    });
    if (cells.length) rows.push(cells);
  });
  if (!rows.length) return '';

  const width = Math.max(...rows.map((r) => r.length));
  const pad = (r) => [...r, ...Array(width - r.length).fill('')];
  const lines = [`| ${pad(rows[0]).join(' | ')} |`, `| ${Array(width).fill('---').join(' | ')} |`];
  for (const row of rows.slice(1)) lines.push(`| ${pad(row).join(' | ')} |`);
  return lines.join('\n');
}

/**
 * @param {Buffer} buffer nội dung .docx
 * @param {{format?: 'markdown'|'text'}} [opts]
 * @returns {{content: string, warnings: string[]}}
 */
export function readDocx(buffer, { format = 'markdown' } = {}) {
  const zip = openZip(buffer);
  const raw = zip.readText('word/document.xml');
  if (!raw) throw new ZipError('Thiếu word/document.xml — file không phải .docx hợp lệ.');

  const xml = dropAlternateFallback(raw);
  const warnings = [];

  let body = xml;
  forEachElement(xml, 'w:body', ({ inner }) => {
    body = inner;
  });

  const blocks = [];
  // Duyệt <w:p> và <w:tbl> theo đúng thứ tự xuất hiện trong tài liệu.
  const TBL = nsTag('tbl');
  const P = nsTag('p');
  const topLevel = new RegExp(`<${TBL}(?:\\s[^>]*)?>|<${P}(?:\\s[^>]*)?>|<${P}\\s*/>`, 'g');
  const isTable = new RegExp(`^<${TBL}`);
  let m;
  let cursor = 0;
  while ((m = topLevel.exec(body))) {
    if (m.index < cursor) continue;
    if (isTable.test(m[0])) {
      const end = findClose(body, 'w:tbl', m.index);
      if (end === -1) break;
      const table = body.slice(m.index, end);
      const md = tableToMarkdown(table);
      // Ở dạng text: bỏ ĐÚNG dòng phân cách `|---|---|` của bảng markdown rồi mới bỏ dấu |.
      // Regex cũ xoá mọi dòng bắt đầu bằng "-", kể cả hàng có số âm ở cột đầu.
      if (md) blocks.push(format === 'markdown' ? md : md.replace(/^\|?(?:\s*:?-+:?\s*\|)+\s*$/gm, '').replace(/\|/g, ' ').replace(/\n{2,}/g, '\n'));
      cursor = end;
      topLevel.lastIndex = end;
    } else {
      const end = findClose(body, 'w:p', m.index);
      if (end === -1) break;
      const para = body.slice(m.index, end);
      const text = runsToText(para);
      const level = headingLevel(para);
      if (text.trim()) {
        blocks.push(format === 'markdown' && level ? `${'#'.repeat(Math.min(level, 6))} ${text}` : text);
      } else {
        blocks.push('');
      }
      cursor = end;
      topLevel.lastIndex = end;
    }
  }

  for (const [part, label] of [
    ['word/header1.xml', 'header'],
    ['word/footer1.xml', 'footer'],
    ['word/footnotes.xml', 'footnote'],
  ]) {
    if (zip.has(part)) warnings.push(`Tài liệu có ${label} — phần này KHÔNG được trích.`);
  }
  if (new RegExp(`<${nsTag('delText')}`).test(raw)) {
    warnings.push('Có tracked changes — phần đã xoá được bỏ qua.');
  }

  const content = blocks
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return { content, warnings };
}

/** Tìm vị trí ngay sau thẻ đóng khớp với thẻ mở tại `from`, có đếm độ sâu. */
function findClose(xml, name, from) {
  const tag = nsTag(name);
  const scan = new RegExp(`<${tag}(\\s[^>]*?)?(/)?>|</${tag}>`, 'g');
  const isClose = new RegExp(`^</${tag}>$`);
  scan.lastIndex = from;
  let depth = 0;
  let m;
  while ((m = scan.exec(xml))) {
    if (isClose.test(m[0])) {
      depth--;
      if (depth === 0) return scan.lastIndex;
    } else if (m[2]) {
      if (depth === 0) return scan.lastIndex; // thẻ tự đóng ngay tại vị trí bắt đầu
    } else {
      depth++;
    }
  }
  return -1;
}
