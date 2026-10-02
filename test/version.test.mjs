import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

test('version giống nhau ở package.json, plugin.json, SERVER_INFO và hai SKILL.md', () => {
  const pkg = JSON.parse(read('package.json')).version;
  assert.equal(pkg, '0.5.1');
  assert.equal(JSON.parse(read('.claude-plugin/plugin.json')).version, pkg);
  assert.match(read('server/index.mjs'), new RegExp(`version: '${pkg.replace(/\./g, '\\.')}'`));
  for (const f of ['skills/gdrive/SKILL.md', 'skills/gdrive-setup/SKILL.md']) {
    assert.match(read(f), new RegExp(`^version: ${pkg.replace(/\./g, '\\.')}$`, 'm'), f);
  }
  assert.match(read('CHANGELOG.md'), new RegExp(`^## \\[${pkg.replace(/\./g, '\\.')}\\]`, 'm'), 'CHANGELOG có mục cho version này');
});

test('SKILL.md và README không còn tên tool cũ', () => {
  for (const f of ['skills/gdrive/SKILL.md', 'src/instructions.mjs']) {
    assert.doesNotMatch(read(f), /gdrive_sheet_read|gdrive_read_document|gdrive_file_info|gdrive_list|gdrive_download|gdrive_upload|gdrive_sheet_write/, f);
  }
});
