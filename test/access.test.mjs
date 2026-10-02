import assert from 'node:assert/strict';
import { test } from 'node:test';

import { AccessError, createAccess, modeFromConfig } from '../src/access.mjs';
import { META_FIELDS } from '../src/meta.mjs';

const SHEET = 'application/vnd.google-apps.spreadsheet';
const SHORTCUT = 'application/vnd.google-apps.shortcut';
const RW = { canEdit: true, canAddChildren: true };
const RO = { canEdit: false, canAddChildren: false };

const FILES = {
  sheetRWaaa: { id: 'sheetRWaaa', name: 'KPI', mimeType: SHEET, capabilities: RW },
  sheetROaaa: { id: 'sheetROaaa', name: 'spec', mimeType: SHEET, capabilities: RO },
  noCapsAaaa: { id: 'noCapsAaaa', name: 'cu', mimeType: SHEET },
  shortAAAAA: { id: 'shortAAAAA', name: 'link', mimeType: SHORTCUT, shortcutDetails: { targetId: 'sheetROaaa' }, capabilities: RW },
  brokenScaa: { id: 'brokenScaa', name: 'hong', mimeType: SHORTCUT },
};

function fakeMeta() {
  const calls = [];
  return {
    calls,
    async file(id) {
      calls.push(id);
      if (!FILES[id]) throw Object.assign(new Error('File not found'), { code: 404 });
      return FILES[id];
    },
  };
}

test('META_FIELDS mang capabilities(canEdit,canAddChildren)', () => {
  assert.match(META_FIELDS, /capabilities\(canEdit,canAddChildren\)/);
});

test('modeFromConfig: không config → readonly; thiếu mode → readwrite; readonly giữ nguyên, folders bị bỏ qua', () => {
  assert.equal(modeFromConfig(null), 'readonly');
  assert.equal(modeFromConfig({ clientEmail: 'x' }), 'readwrite');
  assert.equal(modeFromConfig({ mode: 'readwrite' }), 'readwrite');
  assert.equal(modeFromConfig({ mode: 'readonly', folders: [{ id: 'a', name: 'b', access: 'write' }] }), 'readonly');
});

test('resolve: id và URL (giữ gid), mỗi lần đúng 1 lần đọc metadata', async () => {
  const meta = fakeMeta();
  const access = createAccess({ meta });
  const a = await access.resolve('sheetRWaaa');
  assert.equal(a.fileId, 'sheetRWaaa');
  assert.equal(a.gid, null);
  const b = await access.resolve('https://docs.google.com/spreadsheets/d/sheetRWaaa/edit#gid=7');
  assert.equal(b.fileId, 'sheetRWaaa');
  assert.equal(b.gid, '7');
  assert.deepEqual(meta.calls, ['sheetRWaaa', 'sheetRWaaa']);
});

test('resolve: shortcut giải về file đích (quyền theo đích); shortcut hỏng → NOT_FOUND', async () => {
  const access = createAccess({ meta: fakeMeta() });
  const r = await access.resolve('shortAAAAA');
  assert.equal(r.fileId, 'sheetROaaa');
  assert.equal(access.accessOf(r.meta), 'read');
  await assert.rejects(access.resolve('brokenScaa'), (e) => e instanceof AccessError && e.code === 'NOT_FOUND');
});

test('resolve: Drive 404 ném lên nguyên vẹn (renderError sẽ báo chưa share)', async () => {
  await assert.rejects(createAccess({ meta: fakeMeta() }).resolve('khongShare1'), (e) => e.code === 404 && !(e instanceof AccessError));
});

test('accessOf / assertCanEdit / assertCanAddChildren theo capabilities; thiếu capabilities = chỉ đọc', () => {
  const rw = createAccess({ meta: fakeMeta() });
  rw.assertCanEdit(FILES.sheetRWaaa);
  rw.assertCanAddChildren({ name: 'f', capabilities: RW });
  assert.equal(rw.accessOf(FILES.sheetRWaaa), 'write');
  assert.equal(rw.accessOf(FILES.sheetROaaa), 'read');
  assert.equal(rw.accessOf(FILES.noCapsAaaa), 'read');
  assert.throws(() => rw.assertCanEdit(FILES.sheetROaaa), (e) => e.code === 'READ_ONLY' && e.message === 'Chỉ đọc: service account chưa có quyền Editor với "spec".');
  assert.throws(() => rw.assertCanEdit(FILES.noCapsAaaa), (e) => e.code === 'READ_ONLY');
  assert.throws(() => rw.assertCanAddChildren({ name: 'f', capabilities: RO }), (e) => e.code === 'READ_ONLY' && /"f"/.test(e.message));
});

test('mode readonly: mọi thứ là read, assert ném READ_ONLY kèm gợi ý bật ghi', () => {
  const ro = createAccess({ meta: fakeMeta(), mode: 'readonly' });
  assert.equal(ro.mode, 'readonly');
  assert.equal(ro.accessOf(FILES.sheetRWaaa), 'read');
  assert.throws(() => ro.assertCanEdit(FILES.sheetRWaaa), (e) => e.code === 'READ_ONLY' && /gdrive init --mode readwrite --yes/.test(e.message));
});
