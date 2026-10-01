import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createFolder, downloadFile, exportFile, transferTimeoutMs, updateFile, uploadFile } from '../src/drive.mjs';
import { appendValues, batchUpdateValues } from '../src/sheets.mjs';

function fakeClient(reply = {}) {
  const calls = [];
  return { calls, api: async (opts) => { calls.push(opts); return reply; } };
}

test('updateFile: PATCH đúng tham số addParents/removeParents, body chỉ có name khi đổi tên', async () => {
  const c = fakeClient({ id: 'f', name: 'n', parents: ['p2'] });
  await updateFile(c, 'f', { name: 'n', addParents: 'p2', removeParents: 'p1' });
  const [call] = c.calls;
  assert.equal(call.method, 'PATCH');
  assert.match(call.url, /\/files\/f\?/);
  assert.match(call.url, /addParents=p2/);
  assert.match(call.url, /removeParents=p1/);
  assert.match(call.url, /supportsAllDrives=true/);
  assert.deepEqual(call.body, { name: 'n' });
  assert.notEqual(call.idempotent, false, 'PATCH là idempotent');

  const c2 = fakeClient({});
  await updateFile(c2, 'f', { addParents: 'p2' });
  assert.deepEqual(c2.calls[0].body, {});
});

test('request KHÔNG idempotent được đánh dấu: append, createFolder, uploadFile multipart', async () => {
  const c = fakeClient({ updates: {} });
  await appendValues(c, 's', "'T'!A1", [['x']]);
  await createFolder(c, { name: 'd', parentId: 'p' });
  await uploadFile(c, { name: 'f', folderId: 'p', content: 'abc', mimeType: 'text/plain' });
  for (const call of c.calls) assert.equal(call.idempotent, false, call.url);
});

test('batchUpdateValues giữ idempotent (ghi đè ô là an toàn khi gửi lại)', async () => {
  const c = fakeClient({ totalUpdatedCells: 1, responses: [] });
  await batchUpdateValues(c, 's', [{ range: "'T'!A1", values: [['x']] }]);
  assert.notEqual(c.calls[0].idempotent, false);
});

test('downloadFile/exportFile nới timeout lên 120 s vì timeout bao cả lúc đọc body', async () => {
  const c = fakeClient(Buffer.from(''));
  await downloadFile(c, 'f');
  await exportFile(c, 'f', 'text/plain');
  assert.equal(c.calls.length, 2);
  for (const call of c.calls) assert.equal(call.timeoutMs, 120_000, call.url);
});

test('timeout tải/xuất ghi đè được; 0 = không timeout (CLI chờ bao lâu cũng được)', async () => {
  const c = fakeClient(Buffer.from(''));
  await downloadFile(c, 'f', { timeoutMs: 0 });
  await exportFile(c, 'f', 'text/plain', { timeoutMs: 0 });
  assert.deepEqual(c.calls.map((x) => x.timeoutMs), [0, 0]);
});

test('upload: timeout co theo kích thước (sàn 256 KiB/s, tối thiểu 120 s) cho cả multipart lẫn PUT resumable', async () => {
  assert.equal(transferTimeoutMs(0), 120_000);
  assert.equal(transferTimeoutMs(256 * 1024 * 500), 500_000);
  const calls = [];
  const c = {
    calls,
    api: async (opts) => {
      calls.push(opts);
      if (opts.responseType === 'raw') return { status: 200, url: 'u', headers: { get: () => 'https://upload.test/session' } };
      return { id: 'x' };
    },
  };
  await uploadFile(c, { name: 'big', folderId: 'p', content: Buffer.alloc(10 * 1024 * 1024) });
  const put = calls.find((x) => x.method === 'PUT');
  assert.ok(put.timeoutMs >= 120_000, `PUT timeoutMs=${put.timeoutMs}`);
  assert.equal(put.timeoutMs, transferTimeoutMs(10 * 1024 * 1024));
  await uploadFile(c, { name: 'small', folderId: 'p', content: 'abc' });
  assert.equal(calls.at(-1).timeoutMs, 120_000, 'multipart cũng được nới');
});
