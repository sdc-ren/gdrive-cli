import assert from 'node:assert/strict';
import { test } from 'node:test';

import { readDocx } from '../src/ooxml-docx.mjs';
import { makeZip } from './helpers/make-zip.mjs';

const BODY = `<?xml version="1.0"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>
  <w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Tiêu đề lớn</w:t></w:r></w:p>
  <w:p><w:pPr><w:pStyle w:val="Heading2"/></w:pPr><w:r><w:t>Mục con</w:t></w:r></w:p>
  <w:p><w:r><w:t xml:space="preserve">Đoạn có </w:t></w:r><w:r><w:tab/><w:t>tab</w:t></w:r><w:r><w:br/><w:t>và ngắt dòng</w:t></w:r></w:p>
  <w:p><w:r><w:instrText> MERGEFIELD Tên \\* MERGEFORMAT </w:instrText></w:r><w:r><w:t>chỉ còn chữ này</w:t></w:r></w:p>
  <w:p><w:r><w:delText>đã bị xoá</w:delText></w:r><w:r><w:t>còn lại</w:t></w:r></w:p>
  <w:tbl>
    <w:tblPr/>
    <w:tr><w:tc><w:p><w:r><w:t>Cột A</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Cột B</w:t></w:r></w:p></w:tc></w:tr>
    <w:tr><w:tc><w:p><w:r><w:t>1</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>có|gạch đứng</w:t></w:r></w:p></w:tc></w:tr>
  </w:tbl>
  <w:p><w:r><w:t>Đoạn cuối &amp; ký tự đặc biệt</w:t></w:r></w:p>
</w:body></w:document>`;

function docx(xml = BODY, extra = []) {
  return makeZip([{ name: 'word/document.xml', data: xml, dataDescriptor: true }, ...extra]);
}

test('heading thành markdown theo đúng cấp', () => {
  const { content } = readDocx(docx());
  assert.match(content, /^# Tiêu đề lớn$/m);
  assert.match(content, /^## Mục con$/m);
});

test('tab và ngắt dòng mềm giữ đúng thứ tự với chữ', () => {
  const { content } = readDocx(docx());
  assert.match(content, /Đoạn có \ttab\nvà ngắt dòng/);
});

test('bỏ mã field <w:instrText>, giữ chữ thật', () => {
  const { content } = readDocx(docx());
  assert.match(content, /^chỉ còn chữ này$/m);
  assert.doesNotMatch(content, /MERGEFIELD/);
});

test('bỏ chữ đã xoá trong tracked changes + cảnh báo', () => {
  const { content, warnings } = readDocx(docx());
  assert.match(content, /^còn lại$/m);
  assert.doesNotMatch(content, /đã bị xoá/);
  assert.ok(warnings.some((w) => /tracked changes/.test(w)));
});

test('bảng thành markdown pipe, escape dấu | trong ô', () => {
  const { content } = readDocx(docx());
  assert.match(content, /\| Cột A \| Cột B \|/);
  assert.match(content, /\| --- \| --- \|/);
  assert.match(content, /\| 1 \| có\\\|gạch đứng \|/);
});

test('đoạn văn trong bảng không bị lặp ra ngoài bảng', () => {
  const { content } = readDocx(docx());
  assert.equal(content.match(/Cột A/g).length, 1);
});

test('giải mã entity', () => {
  const { content } = readDocx(docx());
  assert.match(content, /Đoạn cuối & ký tự đặc biệt/);
});

// Cùng nội dung nằm trong cả <mc:Choice> lẫn <mc:Fallback> → không bỏ Fallback là nhân đôi.
test('bỏ nhánh mc:Fallback để text không bị nhân đôi', () => {
  const xml = `<w:document><w:body>
    <mc:AlternateContent>
      <mc:Choice Requires="wps"><w:p><w:r><w:t>Chữ trong hộp</w:t></w:r></w:p></mc:Choice>
      <mc:Fallback><w:p><w:r><w:t>Chữ trong hộp</w:t></w:r></w:p></mc:Fallback>
    </mc:AlternateContent>
  </w:body></w:document>`;
  const { content } = readDocx(docx(xml));
  assert.equal(content.match(/Chữ trong hộp/g).length, 1);
});

test('cảnh báo header/footer/footnote không được trích', () => {
  const { warnings } = readDocx(
    docx(BODY, [
      { name: 'word/header1.xml', data: '<hdr/>' },
      { name: 'word/footnotes.xml', data: '<fn/>' },
    ]),
  );
  assert.ok(warnings.some((w) => /header/.test(w)));
  assert.ok(warnings.some((w) => /footnote/.test(w)));
});

test('format text bỏ ký hiệu markdown', () => {
  const { content } = readDocx(docx(), { format: 'text' });
  assert.doesNotMatch(content, /^#/m);
  assert.match(content, /Tiêu đề lớn/);
});

test('thiếu word/document.xml → lỗi nói rõ', () => {
  assert.throws(() => readDocx(makeZip([{ name: 'a.txt', data: 'x' }])), /word\/document\.xml/);
});

// Cùng bài học với xlsx: tiền tố namespace không cố định.
test('thẻ dùng tiền tố khác `w:` vẫn đọc được', () => {
  const xml = `<document xmlns="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><body>
    <p><pPr><pStyle val="Heading1"/></pPr><r><t>Không tiền tố</t></r></p>
    <p><r><t>đoạn thường</t></r><r><tab/><t>sau tab</t></r></p>
  </body></document>`;
  const { content } = readDocx(docx(xml));
  assert.match(content, /^# Không tiền tố$/m);
  assert.match(content, /đoạn thường\tsau tab/);
});

test('tài liệu rỗng không nổ', () => {
  const { content } = readDocx(docx('<w:document><w:body/></w:document>'));
  assert.equal(content, '');
});

test('format text: hàng bảng có số âm ở cột đầu KHÔNG bị xoá, chỉ dòng phân cách bị bỏ', () => {
  const xml = `<w:document xmlns:w="w"><w:body><w:tbl><w:tr><w:tc><w:p><w:r><w:t>Số</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Ghi chú</w:t></w:r></w:p></w:tc></w:tr><w:tr><w:tc><w:p><w:r><w:t>-5</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>lỗ</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:body></w:document>`;
  const { content } = readDocx(makeZip([{ name: 'word/document.xml', data: xml }]), { format: 'text' });
  assert.match(content, /-5\s+lỗ/);
  assert.doesNotMatch(content, /---/);
});
