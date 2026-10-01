// Chặn công thức kéo/gửi dữ liệu qua ranh giới phạm vi khi model ghi vào Sheet.
//
// Ghi dùng USER_ENTERED (để "=SUM(...)" vẫn là công thức), nên một ô "=IMPORTRANGE(id,…)"
// sẽ kéo dữ liệu từ file NGOÀI folder được phép vào file trong phạm vi (rồi drive_read đọc
// ra), còn "=IMAGE(url)"/"=IMPORTDATA(url)" gửi request ra ngoài, nhét được dữ liệu vào URL.
// Cờ `s`: công thức Sheets được phép xuống dòng, `.` phải đi qua cả `\n`.

export const BLOCKED_FORMULA_RE = /^\s*=.*\b(IMPORT(RANGE|DATA|XML|HTML|FEED)|IMAGE)\s*\(/is;

const MESSAGE =
  'Không ghi công thức IMPORT*/IMAGE qua AI: công thức này có thể kéo dữ liệu ngoài phạm vi folder hoặc gửi dữ liệu ra ngoài.';

export function assertSafeCellValue(value) {
  if (value == null) return;
  if (BLOCKED_FORMULA_RE.test(String(value))) throw new Error(MESSAGE);
}

/** Tách CSV theo RFC 4180 (ô trong nháy được chứa dấu phẩy, `""` và xuống dòng). */
function csvFields(text) {
  const fields = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',' || ch === '\n' || ch === '\r') {
      fields.push(cur);
      cur = '';
    } else cur += ch;
  }
  fields.push(cur);
  return fields;
}

/** Nội dung CSV/TSV sắp chuyển thành Google Sheet: mọi ô phải qua assertSafeCellValue. */
export function assertSafeTable(text) {
  const s = String(text ?? '');
  // Cùng cách tách với tsvToCsv trong tools.mjs: có tab thì là TSV, mỗi dòng tách theo tab.
  const fields = s.includes('\t') ? s.split(/\r?\n/).flatMap((line) => line.split('\t')) : csvFields(s);
  for (const f of fields) assertSafeCellValue(f);
}
