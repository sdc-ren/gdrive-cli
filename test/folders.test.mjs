import assert from 'node:assert/strict';
import { test } from 'node:test';

import { addFolder, loadFolders, parseFoldersEnv, removeFolder, setAccess, slugify, validateFolders } from '../src/folders.mjs';

test('slugify: bỏ dấu tiếng Việt, thường hoá, thay ký tự lạ bằng -, tối đa 63', () => {
  assert.equal(slugify('Báo cáo Q3 / 2026'), 'bao-cao-q3-2026');
  assert.equal(slugify('  Đội QC  '), 'doi-qc');
  assert.equal(slugify('x'.repeat(100)).length, 63);
  assert.equal(slugify('!!!'), 'folder');
});

test('parseFoldersEnv: "name=id:access,…", access mặc định read', () => {
  assert.deepEqual(parseFoldersEnv('test-run=1XyZ:write, bao-cao=1AbC'), [
    { name: 'test-run', id: '1XyZ', access: 'write' },
    { name: 'bao-cao', id: '1AbC', access: 'read' },
  ]);
  assert.deepEqual(parseFoldersEnv(''), []);
});

test('validateFolders: từ chối tên sai, access lạ, trùng tên, trùng id', () => {
  const ok = [{ name: 'a', id: '1', access: 'read' }];
  assert.deepEqual(validateFolders(ok), ok);
  for (const bad of [
    [{ name: 'Có Dấu', id: '1', access: 'read' }],
    [{ name: 'a', id: '1', access: 'admin' }],
    [{ name: 'a', id: '1', access: 'read' }, { name: 'a', id: '2', access: 'read' }],
    [{ name: 'a', id: '1', access: 'read' }, { name: 'b', id: '1', access: 'read' }],
    [{ name: 'a', access: 'read' }],
  ]) {
    assert.throws(() => validateFolders(bad), (e) => e.code === 'FOLDER_CONFIG', JSON.stringify(bad));
  }
});

test('loadFolders: env thắng config; không có gì thì []', () => {
  const config = { folders: [{ name: 'c', id: '9', access: 'write' }] };
  assert.deepEqual(loadFolders({ config, env: {} }), config.folders);
  assert.deepEqual(loadFolders({ config, env: { GDRIVE_FOLDERS: 'e=8:read' } }), [{ name: 'e', id: '8', access: 'read' }]);
  assert.deepEqual(loadFolders({ config: null, env: {} }), []);
  assert.deepEqual(loadFolders({ config: { mode: 'readwrite' }, env: {} }), [], 'khoá mode cũ không tạo folder');
});

test('addFolder / removeFolder / setAccess là hàm thuần và giữ thứ tự', () => {
  const a = [{ name: 'a', id: '1', access: 'read' }];
  const b = addFolder(a, { name: 'b', id: '2', access: 'write' });
  assert.equal(a.length, 1);
  assert.deepEqual(b.map((f) => f.name), ['a', 'b']);
  assert.throws(() => addFolder(b, { name: 'a', id: '3', access: 'read' }), /đã có/);
  assert.deepEqual(setAccess(b, 'a', 'write')[0].access, 'write');
  assert.throws(() => setAccess(b, 'zzz', 'read'), /không có folder/i);
  assert.deepEqual(removeFolder(b, 'a').map((f) => f.name), ['b']);
});
