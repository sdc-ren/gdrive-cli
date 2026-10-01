import assert from 'node:assert/strict';
import { test } from 'node:test';

import { openZip, ZipError } from '../src/zip.mjs';
import { makeZip } from './helpers/make-zip.mjs';

test('đọc entry deflate và entry stored', () => {
  const zip = openZip(
    makeZip([
      { name: 'a.txt', data: 'nội dung nén '.repeat(20) },
      { name: 'b.txt', data: 'ngắn', store: true },
    ]),
  );
  assert.deepEqual(zip.names(), ['a.txt', 'b.txt']);
  assert.equal(zip.readText('a.txt'), 'nội dung nén '.repeat(20));
  assert.equal(zip.readText('b.txt'), 'ngắn');
});

// Bẫy #1 của ZIP reader tự viết: extra field ở local header thường KHÁC central directory.
test('extra field ở local header khác central directory — vẫn đọc đúng', () => {
  const zip = openZip(
    makeZip([{ name: 'xl/workbook.xml', data: '<workbook/>'.repeat(30), localExtra: 28 }]),
  );
  assert.equal(zip.readText('xl/workbook.xml'), '<workbook/>'.repeat(30));
});

// PowerPoint bật bit này rất thường xuyên; local header khi đó ghi size = 0.
test('data descriptor (bit 3): lấy size từ central directory', () => {
  const zip = openZip(
    makeZip([{ name: 'ppt/slides/slide1.xml', data: '<sld/>'.repeat(50), dataDescriptor: true }]),
  );
  assert.equal(zip.readText('ppt/slides/slide1.xml'), '<sld/>'.repeat(50));
});

test('kết hợp cả hai: data descriptor + local extra', () => {
  const zip = openZip(
    makeZip([{ name: 'x.xml', data: 'abc'.repeat(100), dataDescriptor: true, localExtra: 16 }]),
  );
  assert.equal(zip.readText('x.xml'), 'abc'.repeat(100));
});

// Comment ở EOCD đẩy chữ ký lùi khỏi 22 byte cuối → phải quét ngược.
test('EOCD có comment dài vẫn tìm thấy', () => {
  const zip = openZip(makeZip([{ name: 'a.txt', data: 'hello' }], { comment: 'x'.repeat(5000) }));
  assert.equal(zip.readText('a.txt'), 'hello');
});

test('tên file UTF-8', () => {
  const zip = openZip(makeZip([{ name: 'thư mục/tệp tiếng việt.xml', data: '<a/>' }]));
  assert.ok(zip.has('thư mục/tệp tiếng việt.xml'));
});

test('entry không tồn tại trả null, không ném', () => {
  const zip = openZip(makeZip([{ name: 'a.txt', data: 'x' }]));
  assert.equal(zip.read('không-có.txt'), null);
  assert.equal(zip.readText('không-có.txt'), null);
  assert.equal(zip.has('không-có.txt'), false);
});

test('method lạ → lỗi nói rõ method nào', () => {
  const zip = openZip(makeZip([{ name: 'a.txt', data: 'x', method: 12 /* bzip2 */ }]));
  assert.throws(() => zip.readText('a.txt'), /method 12/);
});

test('entry đặt mật khẩu → lỗi nói rõ', () => {
  const zip = openZip(makeZip([{ name: 'a.txt', data: 'x', encrypted: true }]));
  assert.throws(() => zip.readText('a.txt'), /mật khẩu/);
});

test('không phải ZIP → ZipError chứ không phải lỗi khó hiểu', () => {
  assert.throws(() => openZip(Buffer.from('đây không phải file zip đâu nhé, dài dài một chút')), ZipError);
});

test('buffer rỗng', () => {
  assert.throws(() => openZip(Buffer.alloc(0)), ZipError);
});

test('nhiều entry, đọc đúng từng cái (offset không lệch)', () => {
  const files = Array.from({ length: 25 }, (_, i) => ({
    name: `part${i}.xml`,
    data: `<p>${i}</p>`.repeat(i + 1),
    store: i % 3 === 0,
    localExtra: i % 4 === 0 ? 12 : 0,
    dataDescriptor: i % 5 === 0,
  }));
  const zip = openZip(makeZip(files));
  for (const f of files) {
    assert.equal(zip.readText(f.name), f.data, f.name);
  }
});

test('entry giải nén vượt maxOutputLength → ZipError, không RangeError trần', () => {
  const big = Buffer.alloc(3 * 1024 * 1024, 0x61); // 3 MB chữ a, nén còn vài KB
  const buf = makeZip([{ name: 'bomb.txt', data: big }]);
  const zip = openZip(buf, { maxInflateBytes: 1024 * 1024 });
  assert.throws(() => zip.readText('bomb.txt'), (e) => e.name === 'ZipError' && /quá lớn/.test(e.message));
  assert.equal(openZip(buf).readText('bomb.txt').length, big.length, 'mặc định 256 MB vẫn đọc được');
});
