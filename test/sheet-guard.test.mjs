import assert from 'node:assert/strict';
import { test } from 'node:test';

import { assertSafeCellValue, assertSafeTable, BLOCKED_FORMULA_RE } from '../src/sheet-guard.mjs';

test('BLOCKED_FORMULA_RE: bắt IMPORT*/IMAGE không phân biệt hoa thường, có khoảng trắng', () => {
  for (const v of [
    '=IMPORTRANGE("x","A1")',
    '=importdata("http://x")',
    '   =ImportXml("u","//a")',
    '=  IMPORTRANGE ("x","A1")',
    '=IMPORTHTML("u","table",1)',
    '=IMPORTFEED("u")',
    '=image("http://x")',
    '=IFERROR(IMPORTRANGE("x","A1"),"")',
    '=1+\nIMPORTDATA("http://x")',
  ]) assert.ok(BLOCKED_FORMULA_RE.test(v), v);
  for (const v of ['=SUM(A1:A3)', 'IMPORTRANGE("x")', 'xem IMAGE(1)', '=MYIMAGE(1)', '=IMPORTRANGE', '']) {
    assert.ok(!BLOCKED_FORMULA_RE.test(v), v);
  }
});

test('assertSafeCellValue: ném lỗi nói rõ lý do, không có ✗ đầu dòng', () => {
  assert.throws(() => assertSafeCellValue('=IMPORTRANGE("x","A1")'), (e) => /^Không ghi công thức IMPORT\*\/IMAGE qua AI/.test(e.message));
  assert.doesNotThrow(() => assertSafeCellValue('=SUM(A1:A3)'));
  assert.doesNotThrow(() => assertSafeCellValue(42));
  assert.doesNotThrow(() => assertSafeCellValue(null));
});

test('assertSafeTable: TSV, CSV có nháy, ô nhiều dòng trong nháy', () => {
  assert.throws(() => assertSafeTable('a\tb\n1\t=IMPORTDATA("http://x")'), /IMPORT\*/);
  assert.throws(() => assertSafeTable('a,b\n1,"=IMPORTDATA(""http://x"",1)"'), /IMPORT\*/);
  assert.throws(() => assertSafeTable('a,b\n1,"=1+\nIMAGE(""http://x"")"'), /IMPORT\*/);
  assert.throws(() => assertSafeTable('a,b\n1, =image("u")'), /IMPORT\*/);
  assert.doesNotThrow(() => assertSafeTable('a,b\n1,=SUM(A1:A2)\n"x, IMAGE(1)",2'));
});
