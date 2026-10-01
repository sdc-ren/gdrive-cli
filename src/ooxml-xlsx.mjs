// Đọc .xlsx/.xlsm → string[][] rectangular, cùng shape với values.get của Sheets API.
//
// Thay thế cho chỗ shell ra `python3 -c` + openpyxl trong packflow (2 script), vốn chết
// trên máy chưa `pip install openpyxl`.

import { decodeEntities, forEachElement } from './xml.mjs';
import { openZip, ZipError } from './zip.mjs';

// numFmtId dựng sẵn của ECMA-376 mang nghĩa ngày/giờ.
const BUILTIN_DATE_FORMATS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 45, 46, 47]);

const MS_PER_DAY = 86_400_000;

/** Ref ô "AB12" → {col: 27 (0-based 26), row: 12}. */
export function parseCellRef(ref) {
  const m = /^([A-Z]+)(\d+)$/.exec(String(ref).toUpperCase());
  if (!m) return null;
  let col = 0;
  for (const ch of m[1]) col = col * 26 + (ch.charCodeAt(0) - 64);
  return { col: col - 1, row: Number(m[2]) };
}

/**
 * `sharedStrings.xml`: một <si> có thể vỡ thành nhiều <r><t> khi có định dạng chữ giữa
 * chừng ("Hel" + "lo") → phải NỐI hết. Bỏ <rPh> (ruby tiếng Nhật) nếu không text bị lặp.
 */
export function parseSharedStrings(xml) {
  if (!xml) return [];
  const out = [];
  forEachElement(xml, 'si', ({ inner }) => {
    let text = '';
    // Gỡ <rPh> trước khi gom <t>.
    const cleaned = inner.replace(/<rPh[\s\S]*?<\/rPh>/g, '').replace(/<rPh[^>]*\/>/g, '');
    forEachElement(cleaned, 't', ({ inner: t }) => {
      text += decodeEntities(t);
    });
    out.push(text);
  });
  return out;
}

/** styles.xml → mảng cellXfs, mỗi phần tử cho biết ô dùng style đó có phải ngày/giờ không. */
export function parseStyles(xml) {
  if (!xml) return [];

  const customIsDate = new Map();
  forEachElement(xml, 'numFmts', ({ inner }) => {
    forEachElement(inner, 'numFmt', ({ attrs }) => {
      customIsDate.set(Number(attrs.numFmtId), formatCodeIsDate(attrs.formatCode ?? ''));
    });
  });

  const flags = [];
  forEachElement(xml, 'cellXfs', ({ inner }) => {
    forEachElement(inner, 'xf', ({ attrs }) => {
      const id = Number(attrs.numFmtId ?? 0);
      flags.push(BUILTIN_DATE_FORMATS.has(id) || customIsDate.get(id) === true);
    });
  });
  return flags;
}

/** Bỏ literal trong nháy, ký tự escape và block [..] rồi mới soi ký hiệu ngày/giờ. */
export function formatCodeIsDate(code) {
  const stripped = String(code)
    .replace(/"[^"]*"/g, '')
    .replace(/\\./g, '')
    .replace(/\[[^\]]*\]/g, '');
  return /[ymdhs]/i.test(stripped);
}

/**
 * Serial number của Excel → chuỗi ISO.
 *
 * Bug "1900 là năm nhuận": Excel tin rằng có ngày 1900-02-29 (serial 60), nên lịch của nó
 * lệch 1 ngày kể từ serial 61 trở đi. Vì thế mốc phải đổi:
 *   serial 1–59  → mốc 1899-12-31 (serial 1 = 1900-01-01)
 *   serial ≥ 61  → mốc 1899-12-30, chính độ lệch 1 ngày này hấp thụ ngày ma
 * Dùng một mốc duy nhất cho cả dải là sai — hoặc lệch ngày cũ, hoặc lệch ngày mới.
 *
 * Giới hạn đã biết: serial 60 là ngày KHÔNG tồn tại (1900-02-29), hàm này trả 1900-03-01.
 * Thực tế không có dữ liệu thật nào rơi vào đó.
 */
export function serialToIso(serial, { date1904 = false } = {}) {
  const base = date1904
    ? Date.UTC(1904, 0, 1)
    : serial < 61
      ? Date.UTC(1899, 11, 31)
      : Date.UTC(1899, 11, 30);
  const ms = base + Math.round(serial * MS_PER_DAY);
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return String(serial);

  const date = d.toISOString().slice(0, 10);
  const hasTime = Math.abs(serial % 1) > 1e-9;
  if (!hasTime) return date;
  const time = d.toISOString().slice(11, 19);
  // Serial < 1 = chỉ có giờ, không có ngày.
  return serial < 1 ? time : `${date}T${time}`;
}

function relTargetToPath(target) {
  const t = String(target).replace(/^\.\//, '');
  return t.startsWith('/') ? t.slice(1) : `xl/${t}`;
}

/**
 * Ánh xạ r:id → đường dẫn part.
 * BẮT BUỘC đi qua file rels: thứ tự tab trong workbook.xml KHÔNG nhất thiết trùng với
 * sheet1/sheet2/... — đoán theo tên file là nguồn lỗi âm thầm.
 */
function parseRels(xml) {
  const map = new Map();
  if (!xml) return map;
  forEachElement(xml, 'Relationship', ({ attrs }) => {
    if (attrs.Id && attrs.Target) map.set(attrs.Id, relTargetToPath(attrs.Target));
  });
  return map;
}

function parseWorkbook(xml) {
  const sheets = [];
  let date1904 = false;

  forEachElement(xml, 'workbookPr', ({ attrs }) => {
    date1904 = attrs.date1904 === '1' || attrs.date1904 === 'true';
  });

  // Tiền tố của namespace relationships không cố định ("r" là thói quen, không phải luật).
  const REL_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
  const relPrefixes = new Set(['r']);
  const collectPrefixes = (attrs) => {
    for (const [k, v] of Object.entries(attrs)) if (k.startsWith('xmlns:') && v === REL_NS) relPrefixes.add(k.slice(6));
  };
  forEachElement(xml, 'workbook', ({ attrs }) => collectPrefixes(attrs));
  const relId = (attrs) => {
    collectPrefixes(attrs);
    for (const p of relPrefixes) if (attrs[`${p}:id`]) return attrs[`${p}:id`];
    return Object.entries(attrs).find(([k]) => /^[\w.-]+:id$/.test(k))?.[1] ?? attrs.id ?? '';
  };

  forEachElement(xml, 'sheets', ({ inner }) => {
    forEachElement(inner, 'sheet', ({ attrs }) => {
      sheets.push({
        title: attrs.name ?? '',
        gid: String(attrs.sheetId ?? ''),
        rid: relId(attrs),
        state: attrs.state ?? 'visible',
        index: sheets.length,
      });
    });
  });

  return { sheets, date1904 };
}

/** Một <c> → giá trị chuỗi. */
function cellValue(inner, attrs, { sharedStrings, styleIsDate, date1904 }) {
  const type = attrs.t ?? 'n';

  if (type === 'inlineStr') {
    let text = '';
    forEachElement(inner, 'is', ({ inner: is }) => {
      forEachElement(is, 't', ({ inner: t }) => {
        text += decodeEntities(t);
      });
    });
    return text;
  }

  // <v> là giá trị; với t="str" đó là kết quả công thức đã cache.
  let raw = null;
  forEachElement(inner, 'v', ({ inner: v }) => {
    raw = decodeEntities(v);
  });
  if (raw === null) return '';

  if (type === 's') {
    const idx = Number(raw);
    return sharedStrings[idx] ?? '';
  }
  if (type === 'b') return raw === '1' ? 'TRUE' : 'FALSE';
  if (type === 'e' || type === 'str') return raw;

  const num = Number(raw);
  if (!Number.isFinite(num)) return raw;

  const styleIdx = attrs.s === undefined ? -1 : Number(attrs.s);
  if (styleIdx >= 0 && styleIsDate[styleIdx]) return serialToIso(num, { date1904 });
  return raw;
}

/**
 * Sheet XML → string[][] hình chữ nhật.
 *
 * Row và cell trong xlsx là THƯA: `<row r="5">` có thể ngay sau `<row r="2">`, và
 * `<c r="D5">` ngay sau `<c r="A5">`. Phải điền "" vào chỗ trống, không thì mọi cột lệch
 * mà nhìn vẫn có vẻ hợp lý.
 */
export function parseSheetXml(xml, ctx) {
  const rowsByIndex = new Map();
  let maxRow = 0;
  let maxCol = 0;

  forEachElement(xml, 'sheetData', ({ inner: sheetData }) => {
    let fallbackRow = 0;
    forEachElement(sheetData, 'row', ({ attrs: rowAttrs, inner: rowInner }) => {
      fallbackRow += 1;
      const rowNum = Number(rowAttrs.r ?? fallbackRow);
      fallbackRow = rowNum;

      const cells = new Map();
      let fallbackCol = -1;
      forEachElement(rowInner, 'c', ({ attrs, inner }) => {
        const ref = attrs.r ? parseCellRef(attrs.r) : null;
        const col = ref ? ref.col : ++fallbackCol;
        fallbackCol = col;
        const value = cellValue(inner, attrs, ctx);
        cells.set(col, value);
        if (col + 1 > maxCol) maxCol = col + 1;
      });

      if (cells.size) {
        rowsByIndex.set(rowNum, cells);
        if (rowNum > maxRow) maxRow = rowNum;
      }
    });
  });

  const out = [];
  for (let r = 1; r <= maxRow; r++) {
    const cells = rowsByIndex.get(r);
    const row = new Array(maxCol).fill('');
    if (cells) for (const [col, value] of cells) row[col] = value;
    out.push(row);
  }
  return out;
}

/**
 * Mở một buffer .xlsx.
 * @returns {{sheets: Array, date1904: boolean, readSheet: (sel?) => {sheet, rows}}}
 */
export function openXlsx(buffer) {
  const zip = openZip(buffer);

  const workbookXml = zip.readText('xl/workbook.xml');
  if (!workbookXml) {
    throw new ZipError('Thiếu xl/workbook.xml — file không phải .xlsx hợp lệ.');
  }

  const { sheets, date1904 } = parseWorkbook(workbookXml);
  const rels = parseRels(zip.readText('xl/_rels/workbook.xml.rels'));
  const sharedStrings = parseSharedStrings(zip.readText('xl/sharedStrings.xml'));
  const styleIsDate = parseStyles(zip.readText('xl/styles.xml'));

  const withPath = sheets.map((s, i) => ({
    ...s,
    path: rels.get(s.rid) ?? `xl/worksheets/sheet${i + 1}.xml`,
  }));

  return {
    date1904,
    sheets: withPath.map(({ title, gid, index, state }) => ({
      title,
      gid,
      index,
      state,
      rows: 0,
      cols: 0,
    })),

    readSheet(selector = {}) {
      const picked = pickXlsxSheet(withPath, selector);
      const xml = zip.readText(picked.path);
      if (xml === null) throw new ZipError(`Không tìm thấy part "${picked.path}" trong file.`);
      const rows = parseSheetXml(xml, { sharedStrings, styleIsDate, date1904 });
      return {
        sheet: {
          title: picked.title,
          gid: picked.gid,
          index: picked.index,
          state: picked.state,
          rows: rows.length,
          cols: rows[0]?.length ?? 0,
        },
        rows,
      };
    },
  };
}

/** Cùng luật chọn tab như sheets.pickSheet: tên → sheetId → tab đầu. */
export function pickXlsxSheet(sheets, { sheet = null, gid = null } = {}) {
  if (!sheets.length) throw new ZipError('File .xlsx không có sheet nào.');
  if (sheet !== null && sheet !== undefined && sheet !== '') {
    const key = String(sheet);
    const hit =
      sheets.find((s) => s.title === key) ??
      sheets.find((s) => s.title.toLowerCase() === key.toLowerCase()) ??
      (/^\d+$/.test(key) ? sheets.find((s) => s.gid === key) : undefined);
    if (hit) return hit;
    throw new ZipError(
      `Không có sheet "${key}". Các sheet hiện có: ${sheets.map((s) => s.title).join(', ')}`,
    );
  }
  if (gid) {
    const hit = sheets.find((s) => s.gid === String(gid));
    if (hit) return hit;
  }
  return sheets[0];
}
