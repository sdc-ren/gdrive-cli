import assert from 'node:assert/strict';
import { test } from 'node:test';

import { resolveCliMode, resolveCliTarget } from '../src/cli-scope.mjs';

const FOLDER = 'application/vnd.google-apps.folder';
const SHEET = 'application/vnd.google-apps.spreadsheet';

// Cây giả (id >= 8 ký tự): rootRead (read) ── fileRead ; rootWrite (write) ── fileWrite ;
// outsideFolder ── fileOutside
const TREE = {
  rootRead: { mimeType: FOLDER, name: 'Bao cao', parents: [] },
  fileRead: { mimeType: SHEET, name: 'r', parents: ['rootRead'] },
  rootWrite: { mimeType: FOLDER, name: 'Test Run', parents: [] },
  fileWrite: { mimeType: SHEET, name: 'w', parents: ['rootWrite'] },
  outsideFolder: { mimeType: FOLDER, name: 'Khac', parents: [] },
  fileOutside: { mimeType: SHEET, name: 'o', parents: ['outsideFolder'] },
};
const FOLDERS = [
  { id: 'rootRead', name: 'bao-cao', access: 'read' },
  { id: 'rootWrite', name: 'test-run', access: 'write' },
];

function fakeMetaFactory() {
  const calls = [];
  const createMeta = () => ({
    file: async (id) => {
      calls.push(id);
      if (!TREE[id]) throw Object.assign(new Error('File not found'), { code: 404 });
      return { id, ...TREE[id] };
    },
    findChild: async () => null,
  });
  return { calls, createMeta };
}

test('không có folder: trả kết quả parseGoogleUrl, không gọi API nào', async () => {
  const { calls, createMeta } = fakeMetaFactory();
  const url = 'https://docs.google.com/spreadsheets/d/1AbCdEfGhIjK/edit#gid=42';
  for (const write of [false, true]) {
    const res = await resolveCliTarget({ client: null, input: url, write, folders: [], createMeta });
    assert.deepEqual(res, { id: '1AbCdEfGhIjK', gid: '42' });
  }
  assert.deepEqual(calls, []);
});

test('file trong folder read: đọc được, ghi bị từ chối READ_ONLY', async () => {
  const { createMeta } = fakeMetaFactory();
  const res = await resolveCliTarget({ client: null, input: 'fileRead', write: false, folders: FOLDERS, createMeta });
  assert.deepEqual(res, { id: 'fileRead', gid: null });
  await assert.rejects(
    resolveCliTarget({ client: null, input: 'fileRead', write: true, folders: FOLDERS, createMeta }),
    (e) => e.code === 'READ_ONLY',
  );
  const ok = await resolveCliTarget({ client: null, input: 'fileWrite', write: true, folders: FOLDERS, createMeta });
  assert.equal(ok.id, 'fileWrite');
});

test('file ngoài phạm vi → OUT_OF_SCOPE (cả đọc lẫn ghi)', async () => {
  const { createMeta } = fakeMetaFactory();
  for (const write of [false, true]) {
    await assert.rejects(
      resolveCliTarget({ client: null, input: 'fileOutside', write, folders: FOLDERS, createMeta }),
      (e) => e.code === 'OUT_OF_SCOPE',
    );
  }
});

test('mode: có folders thì bỏ qua cfg.mode, suy từ access; không có folders giữ logic cũ', () => {
  // Không folders: như cũ.
  assert.equal(resolveCliMode({ flags: {}, cfg: { mode: 'readwrite' }, folders: [] }), 'readwrite');
  assert.equal(resolveCliMode({ flags: {}, cfg: null, folders: [] }), 'readonly');
  assert.throws(() => resolveCliMode({ flags: {}, cfg: {}, folders: [], needWrite: true }), (e) => e.exitCode === 3 && /readonly/.test(e.message));
  // Có folder write: readwrite dù cfg.mode = readonly.
  assert.equal(resolveCliMode({ flags: {}, cfg: { mode: 'readonly' }, folders: FOLDERS, needWrite: true }), 'readwrite');
  // Chỉ folder read: readonly, needWrite bị từ chối với thông báo mới.
  const readOnly = [FOLDERS[0]];
  assert.equal(resolveCliMode({ flags: {}, cfg: { mode: 'readwrite' }, folders: readOnly }), 'readonly');
  assert.throws(
    () => resolveCliMode({ flags: {}, cfg: { mode: 'readwrite' }, folders: readOnly, needWrite: true }),
    (e) => e.exitCode === 3 && /Không folder nào có quyền write/.test(e.message),
  );
  // --mode tường minh vẫn thắng.
  assert.equal(resolveCliMode({ flags: { mode: 'readwrite' }, cfg: null, folders: readOnly }), 'readwrite');
});
