import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  formatCodeIsDate,
  openXlsx,
  parseCellRef,
  parseSharedStrings,
  parseStyles,
  serialToIso,
} from '../src/ooxml-xlsx.mjs';
import { makeZip } from './helpers/make-zip.mjs';

const SHARED = `<?xml version="1.0"?>
<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <si><t>Mã TC</t></si>
  <si><r><rPr><b/></rPr><t>Hel</t></r><r><t>lo</t></r></si>
  <si><t xml:space="preserve"> có khoảng trắng </t></si>
  <si><r><t>Kanji</t><rPh sb="0" eb="2"><t>ふり</t></rPh></r></si>
  <si><t>Ký tự &amp; đặc biệt &lt;x&gt;</t></si>
</sst>`;

const STYLES = `<?xml version="1.0"?>
<styleSheet>
  <numFmts count="2">
    <numFmt numFmtId="165" formatCode="dd/mm/yyyy"/>
    <numFmt numFmtId="166" formatCode="0.00&quot;m&quot;"/>
  </numFmts>
  <cellXfs count="4">
    <xf numFmtId="0"/>
    <xf numFmtId="14"/>
    <xf numFmtId="165"/>
    <xf numFmtId="166"/>
  </cellXfs>
</styleSheet>`;

// Thứ tự tab CỐ Ý không khớp số thứ tự file: tab đầu ("Beta") nằm ở sheet2.xml.
const WORKBOOK = `<?xml version="1.0"?>
<workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <workbookPr/>
  <sheets>
    <sheet name="Beta" sheetId="5" r:id="rId1"/>
    <sheet name="Alpha" sheetId="3" r:id="rId2"/>
  </sheets>
</workbook>`;

const RELS = `<?xml version="1.0"?>
<Relationships>
  <Relationship Id="rId1" Target="worksheets/sheet2.xml"/>
  <Relationship Id="rId2" Target="/xl/worksheets/sheet1.xml"/>
</Relationships>`;

// Thưa cả hàng lẫn cột: hàng 2 vắng, ô B1 vắng.
const SHEET_BETA = `<?xml version="1.0"?>
<worksheet><sheetData>
  <row r="1"><c r="A1" t="s"><v>0</v></c><c r="C1" t="s"><v>1</v></c></row>
  <row r="3"><c r="B3" t="s"><v>2</v></c></row>
  <row r="4">
    <c r="A4" s="1"><v>45292</v></c>
    <c r="B4" s="2"><v>45292.5</v></c>
    <c r="C4" s="0"><v>45292</v></c>
  </row>
  <row r="5">
    <c r="A5" t="b"><v>1</v></c>
    <c r="B5" t="e"><v>#DIV/0!</v></c>
    <c r="C5" t="str"><f>A1&amp;""</f><v>kết quả công thức</v></c>
  </row>
  <row r="6"><c r="A6" t="inlineStr"><is><t>chữ inline</t></is></c></row>
</sheetData></worksheet>`;

const SHEET_ALPHA = `<?xml version="1.0"?>
<worksheet><sheetData>
  <row r="1"><c r="A1" t="s"><v>4</v></c></row>
</sheetData></worksheet>`;

function fixture(extra = []) {
  return makeZip([
    { name: 'xl/workbook.xml', data: WORKBOOK },
    { name: 'xl/_rels/workbook.xml.rels', data: RELS, localExtra: 12 },
    { name: 'xl/sharedStrings.xml', data: SHARED },
    { name: 'xl/styles.xml', data: STYLES },
    { name: 'xl/worksheets/sheet1.xml', data: SHEET_ALPHA },
    { name: 'xl/worksheets/sheet2.xml', data: SHEET_BETA, dataDescriptor: true },
    ...extra,
  ]);
}

test('parseCellRef', () => {
  assert.deepEqual(parseCellRef('A1'), { col: 0, row: 1 });
  assert.deepEqual(parseCellRef('Z9'), { col: 25, row: 9 });
  assert.deepEqual(parseCellRef('AA10'), { col: 26, row: 10 });
  assert.deepEqual(parseCellRef('AB12'), { col: 27, row: 12 });
  assert.equal(parseCellRef('rác'), null);
});

test('sharedStrings: nối nhiều <r><t>, bỏ <rPh>, giữ khoảng trắng, decode entity', () => {
  const s = parseSharedStrings(SHARED);
  assert.equal(s[0], 'Mã TC');
  assert.equal(s[1], 'Hello', 'nhiều run phải nối lại');
  assert.equal(s[2], ' có khoảng trắng ', 'xml:space=preserve → KHÔNG trim');
  assert.equal(s[3], 'Kanji', 'ruby <rPh> không được nhân đôi text');
  assert.equal(s[4], 'Ký tự & đặc biệt <x>');
});

test('styles: builtin 14 và custom có ymd là ngày; custom "m" trong nháy thì không', () => {
  const flags = parseStyles(STYLES);
  assert.deepEqual(flags, [false, true, true, false]);
});

test('formatCodeIsDate', () => {
  assert.equal(formatCodeIsDate('dd/mm/yyyy'), true);
  assert.equal(formatCodeIsDate('[$-409]h:mm AM/PM'), true);
  assert.equal(formatCodeIsDate('#,##0.00'), false);
  assert.equal(formatCodeIsDate('0.00"m"'), false, 'chữ trong nháy là literal');
  assert.equal(formatCodeIsDate('#,##0;[Red]-#,##0'), false);
  assert.equal(formatCodeIsDate('General'), false);
});

test('serial → ISO: mốc phải đổi quanh bug năm nhuận 1900', () => {
  // Trước ngày ma: mốc 1899-12-31.
  assert.equal(serialToIso(1), '1900-01-01');
  assert.equal(serialToIso(59), '1900-02-28');
  // Sau ngày ma: mốc 1899-12-30, độ lệch 1 ngày hấp thụ 1900-02-29 không tồn tại.
  assert.equal(serialToIso(61), '1900-03-01');
  assert.equal(serialToIso(45292), '2024-01-01');
  assert.equal(serialToIso(45292.5), '2024-01-01T12:00:00');
  assert.equal(serialToIso(0.75), '18:00:00', 'serial < 1 = chỉ có giờ');
  assert.equal(serialToIso(0, { date1904: true }), '1904-01-01');
});

test('giới hạn đã biết: serial 60 là ngày ma của Excel (1900-02-29)', () => {
  assert.equal(serialToIso(60), '1900-03-01');
});

// Nếu đoán sheetN.xml theo thứ tự tab thay vì tra rels, test này đọc nhầm sang Alpha.
test('map r:id → part qua rels, KHÔNG đoán theo tên sheetN.xml', () => {
  const wb = openXlsx(fixture());
  assert.deepEqual(
    wb.sheets.map((s) => s.title),
    ['Beta', 'Alpha'],
  );
  const first = wb.readSheet();
  assert.equal(first.sheet.title, 'Beta');
  assert.equal(first.rows[0][0], 'Mã TC', 'tab đầu phải là dữ liệu của sheet2.xml');

  const alpha = wb.readSheet({ sheet: 'Alpha' });
  assert.equal(alpha.rows[0][0], 'Ký tự & đặc biệt <x>');
});

test('hàng và ô THƯA được điền "" để ra ma trận chữ nhật', () => {
  const { rows } = openXlsx(fixture()).readSheet();

  // Mọi hàng cùng độ dài.
  const widths = new Set(rows.map((r) => r.length));
  assert.equal(widths.size, 1, 'phải là ma trận chữ nhật');

  assert.deepEqual(rows[0].slice(0, 3), ['Mã TC', '', 'Hello'], 'B1 vắng → ""');
  assert.deepEqual(rows[1].slice(0, 3), ['', '', ''], 'hàng 2 vắng hẳn');
  assert.deepEqual(rows[2].slice(0, 3), ['', ' có khoảng trắng ', ''], 'B3 đúng cột');
});

test('kiểu ô: ngày, boolean, lỗi, công thức cache, inlineStr', () => {
  const { rows } = openXlsx(fixture()).readSheet();
  assert.deepEqual(rows[3].slice(0, 3), ['2024-01-01', '2024-01-01T12:00:00', '45292']);
  assert.deepEqual(rows[4].slice(0, 3), ['TRUE', '#DIV/0!', 'kết quả công thức']);
  assert.equal(rows[5][0], 'chữ inline');
});

test('chọn tab theo gid (sheetId) và theo tên không phân biệt hoa thường', () => {
  const wb = openXlsx(fixture());
  assert.equal(wb.readSheet({ gid: '3' }).sheet.title, 'Alpha');
  assert.equal(wb.readSheet({ sheet: 'alpha' }).sheet.title, 'Alpha');
  assert.equal(wb.readSheet({ sheet: '5' }).sheet.title, 'Beta');
});

test('tab không tồn tại → lỗi liệt kê tab đang có', () => {
  const wb = openXlsx(fixture());
  assert.throws(() => wb.readSheet({ sheet: 'Không có' }), /Beta, Alpha/);
});

test('workbook date1904', () => {
  const zip = makeZip([
    { name: 'xl/workbook.xml', data: WORKBOOK.replace('<workbookPr/>', '<workbookPr date1904="1"/>') },
    { name: 'xl/_rels/workbook.xml.rels', data: RELS },
    { name: 'xl/sharedStrings.xml', data: SHARED },
    { name: 'xl/styles.xml', data: STYLES },
    { name: 'xl/worksheets/sheet1.xml', data: SHEET_ALPHA },
    { name: 'xl/worksheets/sheet2.xml', data: SHEET_BETA },
  ]);
  const wb = openXlsx(zip);
  assert.equal(wb.date1904, true);
  // Cùng serial 45292 nhưng hệ 1904 lệch 1462 ngày.
  assert.equal(wb.readSheet().rows[3][0], '2028-01-02');
});

test('thiếu workbook.xml → lỗi nói rõ, không ném lỗi khó hiểu', () => {
  assert.throws(() => openXlsx(makeZip([{ name: 'a.txt', data: 'x' }])), /xl\/workbook\.xml/);
});

// HỒI QUY: file .xlsx do thư viện sinh (ClosedXML/EPPlus…) dùng tiền tố `x:` cho MỌI thẻ.
// Bản đầu hardcode tên không tiền tố → đọc ra 0 sheet, IM LẶNG, không báo lỗi. Chỉ lộ ra
// khi chạy trên file thật tải từ Drive.
test('thẻ có tiền tố namespace (<x:sheet>) vẫn đọc được', () => {
  const zip = makeZip([
    {
      name: 'xl/workbook.xml',
      data: `<?xml version="1.0" encoding="utf-8"?><x:workbook xmlns:x="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><x:sheets><x:sheet name="Tong quan" sheetId="1" r:id="R47a5609472664e4c" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" /><x:sheet name="Danh muc" sheetId="2" r:id="Rdeb5e3d90c274bc7" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" /></x:sheets></x:workbook>`,
    },
    {
      name: 'xl/_rels/workbook.xml.rels',
      data: `<Relationships><Relationship Id="R47a5609472664e4c" Target="/xl/worksheets/sheet1.xml"/><Relationship Id="Rdeb5e3d90c274bc7" Target="/xl/worksheets/sheet2.xml"/></Relationships>`,
    },
    {
      name: 'xl/sharedStrings.xml',
      data: `<x:sst xmlns:x="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><x:si><x:t>Câu hỏi</x:t></x:si><x:si><x:r><x:t>Hai </x:t></x:r><x:r><x:t>run</x:t></x:r></x:si></x:sst>`,
    },
    {
      name: 'xl/worksheets/sheet1.xml',
      data: `<x:worksheet xmlns:x="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><x:sheetData><x:row r="1"><x:c r="A1" t="s"><x:v>0</x:v></x:c><x:c r="C1" t="s"><x:v>1</x:v></x:c></x:row></x:sheetData></x:worksheet>`,
    },
    { name: 'xl/worksheets/sheet2.xml', data: `<x:worksheet><x:sheetData/></x:worksheet>` },
  ]);

  const wb = openXlsx(zip);
  assert.deepEqual(
    wb.sheets.map((s) => s.title),
    ['Tong quan', 'Danh muc'],
    'không được ra 0 sheet',
  );
  assert.deepEqual(wb.readSheet().rows, [['Câu hỏi', '', 'Hai run']]);
});

test('file không có sharedStrings/styles vẫn đọc được', () => {
  const zip = makeZip([
    { name: 'xl/workbook.xml', data: `<workbook xmlns:r="r"><sheets><sheet name="S" sheetId="1" r:id="rId1"/></sheets></workbook>` },
    { name: 'xl/_rels/workbook.xml.rels', data: `<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>` },
    { name: 'xl/worksheets/sheet1.xml', data: `<worksheet><sheetData><row r="1"><c r="A1"><v>42</v></c></row></sheetData></worksheet>` },
  ]);
  assert.deepEqual(openXlsx(zip).readSheet().rows, [['42']]);
});

test('r:id với tiền tố namespace KHÁC "r" vẫn map đúng part qua rels', () => {
  const buf = makeZip([
    { name: 'xl/workbook.xml', data: `<workbook xmlns:ns1="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Only" sheetId="1" ns1:id="rId7"/></sheets></workbook>` },
    { name: 'xl/_rels/workbook.xml.rels', data: `<Relationships><Relationship Id="rId7" Target="worksheets/sheetX.xml"/></Relationships>` },
    { name: 'xl/worksheets/sheetX.xml', data: `<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>đúng</t></is></c></row></sheetData></worksheet>` },
  ]);
  const wb = openXlsx(buf);
  assert.deepEqual(wb.readSheet({}).rows, [['đúng']]);
});
