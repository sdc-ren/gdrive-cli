import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { runFolder } from '../src/folder-cli.mjs';
import { configPath } from '../src/config.mjs';

const FOLDER = 'application/vnd.google-apps.folder';
const DRIVE = {
  '1AbCdEfGhIjK': { id: '1AbCdEfGhIjK', name: 'Báo cáo Q3', mimeType: FOLDER },
  '1XyZxYzXyZxY': { id: '1XyZxYzXyZxY', name: 'Test Run', mimeType: FOLDER },
  '1FiLeFiLeFiL': { id: '1FiLeFiLeFiL', name: 'not-a-folder', mimeType: 'application/vnd.google-apps.spreadsheet' },
};
const getFile = async (id) => {
  if (!DRIVE[id]) { const e = new Error('File not found'); e.code = 404; throw e; }
  return DRIVE[id];
};

async function sandbox(fn) {
  const home = mkdtempSync(join(tmpdir(), 'gdrive-folder-'));
  const env = {};
  const file = configPath(env, home);
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, JSON.stringify({ clientEmail: 'sa@x.com', privateKey: 'k' }));
  const logs = [];
  try {
    return await fn({ home, env, file, logs, log: (l) => logs.push(l), getFile });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}
const cfg = (file) => JSON.parse(readFileSync(file, 'utf8'));

test('folder add: kiểm tra qua Drive, tên mặc định slug từ tên folder, access mặc định read, giữ credential', async () => {
  await sandbox(async (c) => {
    assert.equal(await runFolder({ _: ['folder', 'add', 'https://drive.google.com/drive/folders/1AbCdEfGhIjK'] }, c), true);
    const saved = cfg(c.file);
    assert.deepEqual(saved.folders, [{ id: '1AbCdEfGhIjK', name: 'bao-cao-q3', access: 'read' }]);
    assert.equal(saved.privateKey, 'k');
    assert.match(c.logs.join('\n'), /bao-cao-q3 \(read\)/);
  });
});

test('folder add --name --access write; trùng tên hoặc trùng id → lỗi, config không đổi', async () => {
  await sandbox(async (c) => {
    await runFolder({ _: ['folder', 'add', '1XyZxYzXyZxY'], name: 'test-run', access: 'write' }, c);
    const before = readFileSync(c.file, 'utf8');
    assert.equal(await runFolder({ _: ['folder', 'add', '1AbCdEfGhIjK'], name: 'test-run' }, c), false);
    assert.equal(await runFolder({ _: ['folder', 'add', '1XyZxYzXyZxY'], name: 'khac' }, c), false);
    assert.equal(readFileSync(c.file, 'utf8'), before);
    assert.match(c.logs.join('\n'), /đã có/);
  });
});

test('folder add: không phải folder, hoặc service account không thấy → lỗi nói đúng bệnh', async () => {
  await sandbox(async (c) => {
    assert.equal(await runFolder({ _: ['folder', 'add', '1FiLeFiLeFiL'] }, c), false);
    assert.match(c.logs.join('\n'), /không phải folder/);
    assert.equal(await runFolder({ _: ['folder', 'add', '1NoNoNoNoNoN'] }, c), false);
    assert.match(c.logs.join('\n'), /chưa share cho sa@x\.com/);
    assert.equal(cfg(c.file).folders, undefined);
  });
});

test('folder list / set / remove', async () => {
  await sandbox(async (c) => {
    await runFolder({ _: ['folder', 'add', '1AbCdEfGhIjK'] }, c);
    await runFolder({ _: ['folder', 'add', '1XyZxYzXyZxY'], access: 'write' }, c);
    c.logs.length = 0;
    await runFolder({ _: ['folder', 'list'] }, c);
    assert.match(c.logs.join('\n'), /bao-cao-q3\s+read\s+1AbCdEfGhIjK/);
    assert.match(c.logs.join('\n'), /test-run\s+write\s+1XyZxYzXyZxY/);
    assert.equal(await runFolder({ _: ['folder', 'set', 'bao-cao-q3'], access: 'write' }, c), true);
    assert.equal(cfg(c.file).folders[0].access, 'write');
    assert.equal(await runFolder({ _: ['folder', 'set', 'bao-cao-q3'], access: 'admin' }, c), false);
    assert.equal(await runFolder({ _: ['folder', 'remove', 'test-run'] }, c), true);
    assert.deepEqual(cfg(c.file).folders.map((f) => f.name), ['bao-cao-q3']);
    assert.equal(await runFolder({ _: ['folder', 'remove', 'zzz'] }, c), false);
  });
});

test('folder list khi trống: hướng dẫn add; lệnh con lạ → false kèm cách dùng', async () => {
  await sandbox(async (c) => {
    assert.equal(await runFolder({ _: ['folder', 'list'] }, c), true);
    assert.match(c.logs.join('\n'), /gdrive folder add/);
    assert.equal(await runFolder({ _: ['folder', 'xyz'] }, c), false);
  });
});

test('GDRIVE_FOLDERS đang đặt thì add/set/remove từ chối sửa file (env thắng, sửa file sẽ không có tác dụng)', async () => {
  await sandbox(async (c) => {
    const env = { GDRIVE_FOLDERS: 'e=1AbCdEfGhIjK:read' };
    assert.equal(await runFolder({ _: ['folder', 'add', '1XyZxYzXyZxY'] }, { ...c, env }), false);
    assert.match(c.logs.join('\n'), /GDRIVE_FOLDERS/);
    assert.equal(cfg(c.file).folders, undefined);
  });
});
