import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createScope, ScopeError } from '../src/scope.mjs';

const FOLDER = 'application/vnd.google-apps.folder';
const SHEET = 'application/vnd.google-apps.spreadsheet';
const SHORTCUT = 'application/vnd.google-apps.shortcut';

// Cây giả:
//   rootA (write) ── sub ── fileInSub (sheet)
//   rootB (read)  ── fileB
//   outside ── fileOutside ; shortcutToOut nằm trong rootA trỏ tới fileOutside
//   (id >= 8 ký tự vì parseGoogleUrl chỉ nhận id trần khớp BARE_ID_RE)
//   multiParent: parents [outside, rootB]
const TREE = {
  rootA: { name: 'Test Run', mimeType: FOLDER, parents: [] },
  sub: { name: 'sub', mimeType: FOLDER, parents: ['rootA'] },
  fileInSub: { name: 'TC_login', mimeType: SHEET, parents: ['sub'] },
  rootB: { name: 'Bao cao', mimeType: FOLDER, parents: [] },
  fileB: { name: 'report.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', parents: ['rootB'] },
  outside: { name: 'Khac', mimeType: FOLDER, parents: [] },
  fileOutside: { name: 'secret', mimeType: SHEET, parents: ['outside'] },
  shortcutToOut: { name: 'link', mimeType: SHORTCUT, parents: ['rootA'], shortcutDetails: { targetId: 'fileOutside', targetMimeType: SHEET } },
  multiParent: { name: 'multi', mimeType: SHEET, parents: ['outside', 'rootB'] },
  loopAAAAA: { name: 'la', mimeType: FOLDER, parents: ['loopBBBBB'] },
  loopBBBBB: { name: 'lb', mimeType: FOLDER, parents: ['loopAAAAA'] },
  ghostParent: { name: 'ghost', mimeType: SHEET, parents: ['khongTonTai', 'rootB'] },
};

function fakeMeta() {
  const calls = [];
  return {
    calls,
    async file(id) {
      calls.push(`file:${id}`);
      const m = TREE[id];
      if (!m) { const e = new Error('not found'); e.code = 404; throw e; }
      return { id, ...m };
    },
    async findChild(parentId, name) {
      calls.push(`child:${parentId}/${name}`);
      const id = Object.keys(TREE).find((k) => TREE[k].parents.includes(parentId) && TREE[k].name === name);
      return id ? { id, ...TREE[id] } : null;
    },
    invalidate() {},
    clear() {},
  };
}

const FOLDERS = [
  { name: 'test-run', id: 'rootA', access: 'write' },
  { name: 'bao-cao', id: 'rootB', access: 'read' },
];

test('danh sách rỗng → NO_FOLDERS cho mọi resolve', async () => {
  const scope = createScope({ folders: [], meta: fakeMeta() });
  await assert.rejects(scope.resolve('fileInSub12345'), (e) => e instanceof ScopeError && e.code === 'NO_FOLDERS');
  assert.equal(scope.hasWrite(), false);
});

test('file trong folder con ở độ sâu 2 thuộc phạm vi; file ngoài bị từ chối kể cả khi đọc được', async () => {
  const meta = fakeMeta();
  const scope = createScope({ folders: FOLDERS, meta });
  const r = await scope.resolve('https://docs.google.com/spreadsheets/d/fileInSub/edit#gid=7');
  assert.equal(r.fileId, 'fileInSub');
  assert.equal(r.gid, '7');
  assert.equal(r.root.name, 'test-run');
  assert.equal(r.meta.name, 'TC_login');
  await assert.rejects(scope.resolve('fileOutside'), (e) => e.code === 'OUT_OF_SCOPE' && /test-run, bao-cao/.test(e.message));
});

test('cache tổ tiên: resolve lần hai cùng file không gọi file() cho tổ tiên nữa', async () => {
  const meta = fakeMeta();
  const scope = createScope({ folders: FOLDERS, meta });
  await scope.resolve('fileInSub');
  const before = meta.calls.length;
  await scope.resolve('fileInSub');
  assert.equal(meta.calls.slice(before).filter((c) => c === 'file:sub' || c === 'file:rootA').length, 0);
});

test('assertWrite: folder read → READ_ONLY; folder write → ok', async () => {
  const scope = createScope({ folders: FOLDERS, meta: fakeMeta() });
  await assert.rejects(scope.assertWrite('fileB'), (e) => e.code === 'READ_ONLY' && /bao-cao/.test(e.message));
  assert.equal((await scope.assertWrite('fileInSub')).name, 'test-run');
});

test('alias và đường dẫn: "test-run" là chính folder, "test-run/sub/TC_login" đi qua findChild', async () => {
  const meta = fakeMeta();
  const scope = createScope({ folders: FOLDERS, meta });
  assert.equal((await scope.resolve('test-run')).fileId, 'rootA');
  const r = await scope.resolve('test-run/sub/TC_login');
  assert.equal(r.fileId, 'fileInSub');
  await assert.rejects(scope.resolve('test-run/khong-co'), (e) => e.code === 'NOT_FOUND');
});

test('shortcut trong phạm vi trỏ ra ngoài → OUT_OF_SCOPE (Review Focus 2)', async () => {
  const scope = createScope({ folders: FOLDERS, meta: fakeMeta() });
  await assert.rejects(scope.resolve('shortcutToOut'), (e) => e.code === 'OUT_OF_SCOPE');
});

test('nhiều parents, một nằm trong phạm vi → thuộc phạm vi (Review Focus 3)', async () => {
  const scope = createScope({ folders: FOLDERS, meta: fakeMeta() });
  assert.equal((await scope.resolve('multiParent')).root.name, 'bao-cao');
});

test('vòng parents không treo: dừng ở độ sâu 32 và báo OUT_OF_SCOPE', async () => {
  const scope = createScope({ folders: FOLDERS, meta: fakeMeta() });
  await assert.rejects(scope.resolve('loopAAAAA'), (e) => e.code === 'OUT_OF_SCOPE');
});

test('invalidateAll: sau khi xoá cache, tổ tiên được tra lại', async () => {
  const meta = fakeMeta();
  const scope = createScope({ folders: FOLDERS, meta });
  await scope.resolve('fileInSub');
  scope.invalidateAll();
  const before = meta.calls.length;
  await scope.resolve('fileInSub');
  assert.ok(meta.calls.slice(before).includes('file:sub'));
});

test('parent không truy cập được (404) bị bỏ qua, parent còn lại vẫn được xét', async () => {
  const scope = createScope({ folders: FOLDERS, meta: fakeMeta() });
  assert.equal((await scope.resolve('ghostParent')).root.name, 'bao-cao');
});
