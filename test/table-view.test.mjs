import assert from 'node:assert/strict';
import { test } from 'node:test';

import { toTsv, viewTable } from '../src/table-view.mjs';

const ROWS = [
  ['ID', 'Trạng thái', 'Ghi chú', 'ID'],
  ['TC1', 'PASS', 'ok', 'dup1'],
  ['TC2', 'FAIL', 'lỗi\tcó tab', 'dup2'],
  ['TC3', 'FAIL'],                       // hàng ragged (Review Focus 4)
  ['TC4', ' PASS ', 'khoảng trắng'],
];

test('mặc định: header + mọi dòng, không next', () => {
  const v = viewTable(ROWS);
  assert.deepEqual(v.header, ROWS[0]);
  assert.equal(v.rows.length, 4);
  assert.equal(v.total, 4);
  assert.equal(v.next, null);
});

test('where so khớp sau trim, AND nhiều điều kiện; columns chiếu theo tên', () => {
  const v = viewTable(ROWS, { where: { 'Trạng thái': 'PASS' }, columns: ['ID', 'Ghi chú'] });
  assert.deepEqual(v.header, ['ID', 'Ghi chú']);
  assert.deepEqual(v.rows, [['TC1', 'ok'], ['TC4', 'khoảng trắng']]);
  assert.equal(viewTable(ROWS, { where: { 'Trạng thái': 'FAIL', ID: 'TC2' } }).rows.length, 1);
});

test('header trùng tên: lấy cột ĐẦU TIÊN (Review Focus 1)', () => {
  const v = viewTable(ROWS, { columns: ['ID'], where: { ID: 'TC1' } });
  assert.deepEqual(v.rows, [['TC1']]);
});

test('tên cột không có → BAD_COLUMN liệt kê header; so khớp không phân biệt hoa thường', () => {
  assert.throws(() => viewTable(ROWS, { columns: ['Khong co'] }), (e) => e.code === 'BAD_COLUMN' && /Trạng thái/.test(e.message));
  assert.deepEqual(viewTable(ROWS, { columns: ['trạng thái'] }).header, ['Trạng thái']);
});

test('phân trang: offset/limit trên dòng đã lọc, next đúng, biên bị kẹp (Review Focus 5)', () => {
  const p1 = viewTable(ROWS, { limit: 2 });
  assert.deepEqual(p1.rows.map((r) => r[0]), ['TC1', 'TC2']);
  assert.equal(p1.next, 2);
  const p2 = viewTable(ROWS, { offset: 2, limit: 2 });
  assert.deepEqual(p2.rows.map((r) => r[0]), ['TC3', 'TC4']);
  assert.equal(p2.next, null);
  assert.equal(viewTable(ROWS, { limit: 999_999 }).limit, 2000);
  assert.equal(viewTable(ROWS, { limit: -5, offset: -3 }).offset, 0);
  assert.equal(viewTable(ROWS, { offset: 50 }).rows.length, 0);
});

test('toTsv: đệm ô thiếu, thay tab/xuống dòng trong ô bằng dấu cách', () => {
  const v = viewTable(ROWS, { where: { ID: 'TC2' } });
  const tsv = toTsv(v.header, v.rows);
  assert.equal(tsv.split('\n').length, 2);
  assert.equal(tsv.split('\n')[1], 'TC2\tFAIL\tlỗi có tab\tdup2');
  const ragged = toTsv(['a', 'b', 'c'], [['1']]);
  assert.equal(ragged.split('\n')[1], '1\t\t');
});

test('bảng rỗng: header rỗng, 0 dòng, không ném', () => {
  const v = viewTable([]);
  assert.deepEqual(v, { header: [], rows: [], total: 0, offset: 0, limit: 200, next: null });
});
