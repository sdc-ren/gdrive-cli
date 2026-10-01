import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseArgs, parseSets } from '../bin/cli.mjs';
import { classify, exportMimeFor, KIND, MIME } from '../src/formats.mjs';

test('phân loại file native của Google', () => {
  assert.equal(classify(MIME.GOOGLE_SHEET).kind, KIND.GOOGLE_SHEET);
  assert.equal(classify(MIME.GOOGLE_SHEET).tabular, true);
  assert.equal(classify(MIME.GOOGLE_DOC).kind, KIND.GOOGLE_DOC);
  assert.equal(classify(MIME.GOOGLE_SLIDES).kind, KIND.GOOGLE_SLIDES);
  assert.equal(classify(MIME.FOLDER).kind, KIND.FOLDER);
});

test('phân loại OOXML', () => {
  assert.deepEqual(classify(MIME.XLSX).readAs, ['read']);
  assert.equal(classify(MIME.XLSM).kind, KIND.XLSX);
  assert.deepEqual(classify(MIME.DOCX).readAs, ['doc']);
  assert.deepEqual(classify(MIME.PPTX).readAs, ['doc']);
});

test('PDF: tải về chứ không trích text', () => {
  const c = classify(MIME.PDF);
  assert.equal(c.kind, KIND.PDF);
  assert.deepEqual(c.readAs, ['get']);
  assert.match(c.note, /gdrive get/);
});

test('Office đời cũ: từ chối kèm cách xử lý, KHÔNG đọc nửa vời', () => {
  for (const mime of [MIME.DOC, MIME.XLS, MIME.PPT]) {
    const c = classify(mime, 'baocao.doc');
    assert.equal(c.kind, KIND.LEGACY);
    assert.deepEqual(c.readAs, [], 'không có đường đọc nào');
    assert.match(c.note, /Lưu dưới dạng Google/);
  }
});

test('Office đời cũ nhận qua ĐUÔI TÊN khi Drive trả mimeType chung chung', () => {
  const c = classify('application/octet-stream', 'ke-hoach.xls');
  assert.equal(c.kind, KIND.LEGACY);
});

test('file text đọc bằng doc', () => {
  assert.equal(classify('text/plain').kind, KIND.TEXT);
  assert.equal(classify(MIME.CSV).tabular, true);
  assert.equal(classify('application/json').kind, KIND.TEXT);
});

test('định dạng lạ → chỉ tải về', () => {
  const c = classify('image/png', 'anh.png');
  assert.equal(c.kind, KIND.OTHER);
  assert.deepEqual(c.readAs, ['get']);
});

test('Slides export .pptx chứ KHÔNG phải text/plain (giữ ranh giới slide)', () => {
  assert.equal(exportMimeFor(KIND.GOOGLE_SLIDES, 'markdown'), MIME.PPTX);
  assert.equal(exportMimeFor(KIND.GOOGLE_SLIDES, 'text'), MIME.PPTX);
});

test('Docs export markdown, --format text thì plain', () => {
  assert.equal(exportMimeFor(KIND.GOOGLE_DOC, 'markdown'), MIME.MARKDOWN);
  assert.equal(exportMimeFor(KIND.GOOGLE_DOC, 'text'), MIME.PLAIN);
  assert.equal(exportMimeFor(KIND.DOCX, 'markdown'), null);
});

// ── parse cờ ────────────────────────────────────────────────────────────────

test('parseArgs: lệnh + tham số vị trí', () => {
  const f = parseArgs(['read', 'https://x/y']);
  assert.deepEqual(f._, ['read', 'https://x/y']);
});

test('parseArgs: cờ boolean và cờ có giá trị', () => {
  const f = parseArgs(['read', 'url', '--json', '--sheet', 'Tab A', '--max-rows', '10']);
  assert.equal(f.json, true);
  assert.equal(f.sheet, 'Tab A');
  assert.equal(f['max-rows'], '10');
});

test('parseArgs: dạng --key=value', () => {
  const f = parseArgs(['read', 'url', '--sheet=Kết quả']);
  assert.equal(f.sheet, 'Kết quả');
});

test('parseArgs: --set lặp lại được, và giá trị chứa dấu = vẫn nguyên vẹn', () => {
  const f = parseArgs(['write', 'url', '--set', 'L5=PASSED', '--set', 'B2=a=b=c']);
  assert.deepEqual(f.set, ['L5=PASSED', 'B2=a=b=c']);
});

test('parseArgs: một --set duy nhất là chuỗi (chỗ gọi phải [].concat)', () => {
  assert.equal(parseArgs(['write', 'url', '--set', 'L5=X']).set, 'L5=X');
});

test('parseArgs: cờ boolean đứng ngay trước tham số vị trí không nuốt nhầm', () => {
  const f = parseArgs(['ls', '--json', 'https://drive/folders/abc']);
  assert.equal(f.json, true);
  assert.deepEqual(f._, ['ls', 'https://drive/folders/abc']);
});

test('parseSets: tách --set Ô=giá trị; thiếu hoặc sai cú pháp → exit 2', () => {
  assert.deepEqual(parseSets(parseArgs(['write', 'u', '--set', 'L5=PASS', '--set', 'A1=a=b'])), [{ cell: 'L5', value: 'PASS' }, { cell: 'A1', value: 'a=b' }]);
  assert.throws(() => parseSets(parseArgs(['write', 'u'])), (e) => e.exitCode === 2 && /Thiếu --set/.test(e.message));
  assert.throws(() => parseSets(parseArgs(['write', 'u', '--set', 'L5'])), (e) => e.exitCode === 2 && /sai cú pháp/.test(e.message));
});
