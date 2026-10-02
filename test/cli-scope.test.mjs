import assert from 'node:assert/strict';
import { test } from 'node:test';

import { resolveCliMode } from '../src/cli-scope.mjs';

test('resolveCliMode: theo modeFromConfig; --mode ghi đè; cần ghi mà readonly → exitCode 3', () => {
  assert.equal(resolveCliMode({ cfg: { clientEmail: 'x' } }), 'readwrite');
  assert.equal(resolveCliMode({ cfg: { mode: 'readonly' } }), 'readonly');
  assert.equal(resolveCliMode({ cfg: null }), 'readonly');
  assert.equal(resolveCliMode({ flags: { mode: 'readwrite' }, cfg: { mode: 'readonly' }, needWrite: true }), 'readwrite');
  assert.equal(resolveCliMode({ cfg: { mode: 'readonly', folders: [{ id: 'a', name: 'b', access: 'write' }] } }), 'readonly', 'folders bị bỏ qua');
  assert.throws(
    () => resolveCliMode({ cfg: { mode: 'readonly' }, needWrite: true }),
    (e) => e.exitCode === 3 && /gdrive init --mode readwrite --yes/.test(e.message),
  );
});
