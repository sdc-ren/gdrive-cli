import assert from 'node:assert/strict';
import { test } from 'node:test';

import { renderDoc, renderError, renderLs, renderTable, typeCode } from '../src/render.mjs';
import { viewTable } from '../src/table-view.mjs';

test('typeCode theo mimeType, rơi về đuôi tên', () => {
  assert.equal(typeCode('application/vnd.google-apps.folder'), 'd');
  assert.equal(typeCode('application/vnd.google-apps.spreadsheet'), 's');
  assert.equal(typeCode('application/vnd.google-apps.document'), 'c');
  assert.equal(typeCode('application/vnd.google-apps.presentation'), 'p');
  assert.equal(typeCode('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'), 'x');
  assert.equal(typeCode('application/octet-stream', 'a.docx'), 'w');
  assert.equal(typeCode('application/octet-stream', 'a.pptx'), 'k');
  assert.equal(typeCode('text/csv'), 't');
  assert.equal(typeCode('image/png'), 'f');
});

test('renderLs: dòng đầu có tên/quyền/số lượng và next, mỗi mục một dòng', () => {
  const out = renderLs({
    title: 'test-run', access: 'write', total: 2, next: 'TOKEN',
    items: [
      { id: '1Abc', name: '2026-Q3', mimeType: 'application/vnd.google-apps.folder' },
      { id: '1Ghi', name: 'report.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', modifiedTime: '2026-09-28T10:00:00Z', size: '49152' },
    ],
  });
  assert.equal(out.split('\n')[0], '# test-run (write) · 2 · next=TOKEN');
  assert.equal(out.split('\n')[1], 'd 2026-Q3 1Abc');
  assert.equal(out.split('\n')[2], 'x report.xlsx 1Ghi 2026-09-28 48KB');
});

test('renderTable: dòng # có file, tab, tabs, rows a-b/total, next; rồi TSV', () => {
  const view = viewTable([['ID', 'S'], ['1', 'a'], ['2', 'b'], ['3', 'c']], { limit: 2 });
  const out = renderTable({ file: 'TC_login', tab: 'Sheet1', tabs: ['Sheet1', 'Data'], view });
  assert.deepEqual(out.split('\n'), ['# TC_login › Sheet1 · tabs: Sheet1,Data · rows 1-2/3 · next=2', 'ID\tS', '1\ta', '2\tb']);
  const last = renderTable({ file: 'f', tab: 't', tabs: ['t'], view: viewTable([['a'], ['1']]) });
  assert.equal(last.split('\n')[0], '# f › t · tabs: t · rows 1-1/1');
  const empty = renderTable({ file: 'f', tab: 't', tabs: ['t'], view: viewTable([['a']]) });
  assert.equal(empty.split('\n')[0], '# f › t · tabs: t · rows 0/0');
});

test('renderDoc: tiêu đề và dòng truncated khi bị cắt', () => {
  const full = renderDoc({ file: 'Guide', kind: 'docx', text: 'xin chào', total: 8, truncatedAt: null });
  assert.equal(full, '# Guide (docx) · 8 chars\nxin chào');
  const cut = renderDoc({ file: 'Guide', kind: 'docx', text: 'xin', total: 8, truncatedAt: 3 });
  assert.equal(cut.split('\n').at(-1), '# truncated at 3/8 chars');
});

test('renderError: AccessError in dòng đầu với ✗', () => {
  const e = Object.assign(new Error('Chỉ đọc: service account chưa có quyền Editor với "KPI".\nchi tiết'), { name: 'AccessError', code: 'READ_ONLY' });
  assert.equal(renderError(e), '✗ Chỉ đọc: service account chưa có quyền Editor với "KPI".');
});

test('renderError: 403 có email, lỗi thường', () => {
  const e403 = Object.assign(new Error('The caller does not have permission'), { code: 403 });
  assert.match(renderError(e403, { email: 'sa@p.iam.gserviceaccount.com' }), /^✗ 403: chưa share cho sa@p\.iam/);
  assert.equal(renderError(new Error('lạ')), '✗ lạ');
  assert.match(renderError(Object.assign(new Error('x'), { code: 'UNCERTAIN_WRITE' })), /^✗ x/);
});

test('renderError: 403 giới hạn tốc độ không bị báo nhầm là "chưa share"', () => {
  const rl = Object.assign(new Error('User rate limit exceeded.'), { code: 403, reason: 'userRateLimitExceeded' });
  assert.equal(renderError(rl, { email: 'sa@p' }), '✗ Drive giới hạn tốc độ, thử lại sau');
  const perm = Object.assign(new Error('nope'), { code: 403, reason: 'forbidden' });
  assert.match(renderError(perm), /chưa share/);
});
