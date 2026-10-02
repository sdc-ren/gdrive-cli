# Kế hoạch triển khai v0.5.0: quyền theo share trên Drive, bỏ danh sách folder

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Người dùng gửi link, AI mở thẳng link đó: service account là Editor thì đọc và ghi, là Viewer thì chỉ đọc, chưa được share thì báo lại. Không còn bước khai báo folder.

**Architecture:** `src/access.mjs` thay `src/scope.mjs` (bỏ danh sách folder và việc lần theo folder cha). Module mới làm ba việc:
- phân giải URL hoặc id thành metadata; với shortcut thì lấy file đích;
- đọc quyền từ `capabilities.canEdit`/`canAddChildren` có sẵn trong metadata đã cache;
- áp khoá `mode` trong config làm công tắc an toàn chung. `readwrite` là mặc định mới của `init`.

Lệnh `gdrive folder` và các module danh sách folder bị xoá.

**Tech Stack:** Node.js >= 18.17, chỉ API có sẵn, test bằng `node --test`.

**Spec:** `docs/superpowers/specs/2026-10-02-share-based-access-design.md`

## Global Constraints

- Node.js >= 18.17; không thêm dependency.
- Stdout của MCP server chỉ chứa frame JSON-RPC.
- Private key chỉ nằm trong đúng một file config, mode 600. Không in ra log, kết quả tool hay config của client.
- Drive là nơi quyết định quyền cuối cùng. Kiểm tra phía client chỉ để báo lỗi rõ ràng và chặn trước khi gọi API ghi.
- Không thêm request nào ngoài việc mở link. Quyền lấy từ metadata đã có.
- `mode`:
  - `readonly`: chỉ có `drive_ls` và `drive_read`, token xin scope `*.readonly`.
  - `readwrite`, hoặc có config mà thiếu `mode`: đủ 5 tool.
  - Không có config: `readonly`.
- Giữ nguyên bộ chặn công thức `IMPORT*`/`IMAGE` (`src/sheet-guard.mjs`).
- Tổng schema tool dưới 700 token ước lượng (`ceil(bytes/3.5)`). CI báo đỏ nếu vượt.
- Đường dẫn dùng `path.join`. Test phải chạy được trên Windows (CRLF, `%APPDATA%`).
- Test không gọi mạng, không đọc config thật (dùng HOME tạm, `client.api` hoặc `fetch` giả).
- Commit theo Conventional Commits, kết thúc bằng `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Nhánh `feat/share-based-access` (đã tách từ `develop`). PR nhắm vào `develop`.

## Review Focus

1. **Shortcut nằm trong folder ghi được nhưng trỏ tới file chỉ đọc.** Quyền phải lấy theo file đích, nên `sheet_write` và `drive_move` báo `READ_ONLY` và không gọi API ghi. Test ở Task 2.
2. **Config v0.4.0 còn `mode: readonly` + `folders`, kèm biến `GDRIVE_FOLDERS`.** Server phải chạy được, bỏ qua cả hai, chỉ có 2 tool. Test ở Task 3.
3. **Metadata không có `capabilities`** (ví dụ ADC trả thiếu field). Phải coi là chỉ đọc và báo "Chỉ đọc", không được coi là ghi được. Test ở Task 1.
4. **`drive_ls` nhận link file thay vì folder.** Phải báo rõ và gợi ý `drive_read`, không liệt kê rỗng. Test ở Task 2.
5. **Link chưa share (Drive trả 404).** Lỗi tới model phải là `✗ 404: chưa share cho <email> …`, không bị bọc thành lỗi khác. Test ở Task 1 (404 ném nguyên) và Task 3 (render).

---

## Thứ tự và phụ thuộc

| Task | Nội dung | Phụ thuộc |
|---|---|---|
| 1 | `meta.mjs` thêm capabilities, bỏ `findChild`; tạo `access.mjs` | — |
| 2 | `render.mjs` (thêm `AccessError`, bỏ `renderFolders`); `tools.mjs` dùng `access` | 1 |
| 3 | `server/index.mjs` chạy theo `mode`; `instructions.mjs` | 2 |
| 4 | CLI bỏ `folder`, rút gọn `cli-scope`, sửa `status` và `init`; xoá module folder; bench | 1, 2 |
| 5 | Tài liệu, bump 0.5.0 | 1–4 |
| 6 | Kiểm chứng trên Drive thật, đo request | 1–5 |

Từ Task 1 tới hết Task 4, `node --test` chạy toàn bộ sẽ chưa xanh vì `scope.mjs`, `cli-scope.mjs` và `bin/cli.mjs` vẫn còn tham chiếu tới những thứ đang đổi. Ở Task 1–3 chỉ chạy các file test được nêu tên.

---

### Task 1: `meta.mjs` mang capabilities; `access.mjs`

**Files:**
- Modify: `src/meta.mjs`
  - dòng 8: `META_FIELDS`;
  - xoá hàm `findChild` (dòng 17–24) và import `listFiles`.
- Create: `src/access.mjs`
- Test: `test/access.test.mjs`

**Interfaces:**
- Consumes:
  - `parseGoogleUrl(input) → { kind, id, gid }` (`gid` là `null` khi không có) từ `src/url.mjs`;
  - `meta.file(id)` từ `createMetaStore`.
- Produces:
  - `META_FIELDS === 'id,name,mimeType,size,parents,driveId,modifiedTime,webViewLink,shortcutDetails,capabilities(canEdit,canAddChildren)'`
  - `READONLY_HINT = 'bật ghi: gdrive init --mode readwrite --yes'`
  - `class AccessError extends Error` có `name = 'AccessError'`, `code` là `'READ_ONLY'` hoặc `'NOT_FOUND'`.
  - `modeFromConfig(cfg) → 'readonly'|'readwrite'`
  - `createAccess({ meta, mode = 'readwrite' })` trả về:
    - `mode`;
    - `resolve(input) → Promise<{ fileId, meta, gid }>`;
    - `accessOf(meta) → 'read'|'write'`;
    - `assertCanEdit(meta)`;
    - `assertCanAddChildren(meta)`.

- [ ] **Step 1: Viết test hỏng**

Tạo `test/access.test.mjs`:

```js
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
```

- [ ] **Step 2: Chạy test, xác nhận hỏng**

Run: `node --test test/access.test.mjs`
Expected: FAIL với `Cannot find module '.../src/access.mjs'`.

- [ ] **Step 3: Cài đặt**

`src/meta.mjs`:
- Dòng 8:

```js
export const META_FIELDS = 'id,name,mimeType,size,parents,driveId,modifiedTime,webViewLink,shortcutDetails,capabilities(canEdit,canAddChildren)';
```

- Xoá phương thức `findChild`. Chỉ `scope.mjs` dùng nó, và file đó bị xoá ở Task 4.
- Sửa dòng import thành `import { getFile } from './drive.mjs';`.

Tạo `src/access.mjs`:

```js
// Quyền theo share trên Drive (v0.5.0). Người dùng gửi link, server mở thẳng link đó: service
// account mở được thì đọc được, là Editor thì ghi được. Quyền đọc từ `capabilities` nằm sẵn
// trong metadata đã cache, nên không tốn thêm request. Kiểm tra ở đây để báo lỗi dễ hiểu và
// chặn trước khi gọi API ghi; Drive vẫn là nơi chặn cuối cùng.

import { parseGoogleUrl } from './url.mjs';

const MIME_SHORTCUT = 'application/vnd.google-apps.shortcut';

export const READONLY_HINT = 'bật ghi: gdrive init --mode readwrite --yes';

export class AccessError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'AccessError';
    this.code = code;
  }
}

/** Không có config: readonly (chưa có credential). Có config mà thiếu `mode`: readwrite. */
export function modeFromConfig(cfg) {
  if (!cfg) return 'readonly';
  return cfg.mode === 'readonly' ? 'readonly' : 'readwrite';
}

export function createAccess({ meta, mode = 'readwrite' }) {
  const writable = (flag) => mode === 'readwrite' && flag === true;

  function deny(flag, m) {
    if (mode !== 'readwrite') throw new AccessError('READ_ONLY', `Đang ở chế độ readonly, không ghi. ${READONLY_HINT}`);
    if (flag !== true) throw new AccessError('READ_ONLY', `Chỉ đọc: service account chưa có quyền Editor với "${m?.name ?? '?'}".`);
  }

  return {
    mode,

    /** URL Google hoặc id → metadata. Shortcut thì trả file đích; lỗi 404 của Drive ném nguyên. */
    async resolve(input) {
      const { id, gid } = parseGoogleUrl(String(input ?? '').trim());
      let m = await meta.file(id);
      if (m.mimeType === MIME_SHORTCUT) {
        const targetId = m.shortcutDetails?.targetId;
        if (!targetId) throw new AccessError('NOT_FOUND', `Shortcut "${m.name}" không có đích.`);
        m = await meta.file(targetId);
      }
      return { fileId: m.id, meta: m, gid };
    },

    accessOf: (m) => (writable(m?.capabilities?.canEdit) ? 'write' : 'read'),
    assertCanEdit: (m) => deny(m?.capabilities?.canEdit, m),
    assertCanAddChildren: (m) => deny(m?.capabilities?.canAddChildren, m),
  };
}
```

- [ ] **Step 4: Chạy test, xác nhận qua**

Run: `node --test test/access.test.mjs`
Expected: PASS cả 7 test.

- [ ] **Step 5: Commit**

```bash
git add src/access.mjs src/meta.mjs test/access.test.mjs
git commit -m "feat(access): quyền theo capabilities của Drive; metadata mang canEdit

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: `render.mjs` và `tools.mjs` dùng `access`

**Files:**
- Modify: `src/render.mjs`
  - xoá `renderFolders` (dòng 38–41);
  - đổi nhánh `ScopeError` trong `renderError`.
- Modify: `src/tools.mjs`
- Test: `test/render.test.mjs`, `test/tools.test.mjs`

**Interfaces:**
- Consumes:
  - `createAccess`, `AccessError` (Task 1);
  - `createMetaStore` (`src/meta.mjs`).
- Produces:
  - `buildTools({ getClient, mode = 'readwrite', now = Date.now }) → Array<{ name, write, description, inputSchema, run }>`. Với `mode: 'readonly'` chỉ còn `drive_ls` và `drive_read`.
  - `renderError(err, { email })`: với `AccessError` trả `✗ <dòng đầu>`.
  - `renderFolders` bị xoá.

- [ ] **Step 1: Viết test hỏng**

`test/render.test.mjs`:
- Bỏ `renderFolders` khỏi import.
- Xoá test của `renderFolders`, tức đoạn assert `'# 2 folders\nd test-run (write) 1XyZ\nd bao-cao (read) 1AbC'`.
- Thêm test dưới đây. Nếu `renderError` chưa có trong import thì thêm vào.

```js
test('renderError: AccessError in dòng đầu với ✗', () => {
  const e = Object.assign(new Error('Chỉ đọc: service account chưa có quyền Editor với "KPI".\nchi tiết'), { name: 'AccessError', code: 'READ_ONLY' });
  assert.equal(renderError(e), '✗ Chỉ đọc: service account chưa có quyền Editor với "KPI".');
});
```

`test/tools.test.mjs`:

1. Thay `const FILES = {…}` (dòng 11–20) bằng:

```js
const RW = { canEdit: true, canAddChildren: true };
const RO = { canEdit: false, canAddChildren: false };
const FILES = {
  rootAaaaa: { id: 'rootAaaaa', name: 'Test Run', mimeType: FOLDER, parents: [], driveId: 'sd1', capabilities: RW },
  rootCaaaa: { id: 'rootCaaaa', name: 'My Drive folder', mimeType: FOLDER, parents: [], capabilities: RW },
  sheet1aaaa: { id: 'sheet1aaaa', name: 'TC_login', mimeType: GSHEET, parents: ['rootAaaaa'], modifiedTime: '2026-09-30T00:00:00Z', capabilities: RW },
  book1aaaa: { id: 'book1aaaa', name: 'report.xlsx', mimeType: XLSX, parents: ['rootAaaaa'], size: '2048', capabilities: RW },
  rootBaaaa: { id: 'rootBaaaa', name: 'Bao cao', mimeType: FOLDER, parents: [], capabilities: RO },
  sheetBaaaa: { id: 'sheetBaaaa', name: 'KPI', mimeType: GSHEET, parents: ['rootBaaaa'], capabilities: RO },
};
```

2. Thay `FOLDERS_RW`, `FOLDERS_RO` và hàm `tools` bằng:

```js
const tools = (mode = 'readwrite', client = fakeClient()) => {
  const list = buildTools({ getClient: () => client, mode });
  return { client, byName: new Map(list.map((t) => [t.name, t])), names: list.map((t) => t.name) };
};
```

3. Thay đồng loạt trong các test còn giữ:

| Cũ | Mới |
|---|---|
| `tools(FOLDERS_RW)` | `tools()` |
| `tools(FOLDERS_RW, fakeClient(…))` | `tools('readwrite', fakeClient(…))` |
| địa chỉ `'test-run'` | `'rootAaaaa'` |
| địa chỉ `'bao-cao'` | `'rootBaaaa'` |
| địa chỉ `'my-drive'` | `'rootCaaaa'` |
| địa chỉ `'test-run/Sub'` | `'subAaaaaa'` |
| `buildTools({ getClient: () => null, folders: FOLDERS_RW })` | `buildTools({ getClient: () => null, mode: 'readwrite' })` |

   Thêm `capabilities: RW` vào `SUB.subAaaaaa`.

4. Xoá 4 test:
   - `drive_ls folder rỗng danh sách → NO_FOLDERS…`
   - `drive_read xlsx: đọc tab, TSV; ngoài phạm vi → OUT_OF_SCOPE`
   - `drive_move: không đổi tên/di chuyển folder gốc trong danh sách`
   - `folder rỗng: báo NO_FOLDERS trước khi dựng client…`

5. Thay các test tương ứng (hoặc thêm mới) bằng các test sau:

```js
test('tool ghi có ở readwrite, ẩn ở readonly; schema gọn', () => {
  assert.deepEqual(tools().names, ['drive_ls', 'drive_read', 'sheet_write', 'drive_create', 'drive_move']);
  assert.deepEqual(tools('readonly').names, ['drive_ls', 'drive_read']);
  const bytes = JSON.stringify(buildTools({ getClient: () => null, mode: 'readwrite' }).map(({ name, description, inputSchema }) => ({ name, description, inputSchema }))).length;
  assert.ok(Math.ceil(bytes / 3.5) < 700, `schema ≈ ${Math.ceil(bytes / 3.5)} token`);
});

test('drive_ls: link folder → một dòng mỗi mục, nhãn theo canEdit; path bắt buộc; link file → gợi ý drive_read', async () => {
  const { byName } = tools();
  const ls = byName.get('drive_ls');
  assert.deepEqual(ls.inputSchema.required, ['path']);
  const out = await ls.run({ path: 'https://drive.google.com/drive/folders/rootAaaaa' });
  assert.equal(out.split('\n')[0], '# Test Run (write) · 2');
  assert.ok(out.includes('s TC_login sheet1aaaa 2026-09-30'));
  assert.ok(out.includes('x report.xlsx book1aaaa 2KB'));
  assert.equal((await ls.run({ path: 'rootBaaaa' })).split('\n')[0], '# Bao cao (read) · 1');
  await assert.rejects(ls.run({ path: 'sheet1aaaa' }), (e) => e.code === 'NOT_FOUND' && /drive_read/.test(e.message));
});

test('drive_ls readonly: folder Editor vẫn hiện (read)', async () => {
  const { byName } = tools('readonly');
  assert.equal((await byName.get('drive_ls').run({ path: 'rootAaaaa' })).split('\n')[0], '# Test Run (read) · 2');
});

test('drive_read xlsx bằng id; link không share → lỗi 404 nguyên vẹn', async () => {
  const { byName } = tools();
  const out = await byName.get('drive_read').run({ target: 'book1aaaa' });
  assert.equal(out.split('\n')[0], '# report.xlsx › Data · tabs: Data · rows 1-1/1');
  assert.equal(out.split('\n')[2], '42');
  await assert.rejects(byName.get('drive_read').run({ target: 'khongShare1' }), (e) => e.code === 404);
});

test('sheet_write: cells → 1 batchUpdate, append → 1 append không idempotent; file Viewer → READ_ONLY, không gọi API ghi', async () => {
  const { byName, client } = tools();
  const out = await byName.get('sheet_write').run({ target: 'sheet1aaaa', cells: { L5: 'PASS', L6: 'FAIL' }, append: [['TC9', 'PASS', '']] });
  assert.equal(out, '✓ Sheet1: 2 cells, +1 rows');
  const batch = client.calls.find((c) => /batchUpdate/.test(c.url));
  assert.deepEqual(batch.body.data.map((d) => d.range), ["'Sheet1'!L5", "'Sheet1'!L6"]);
  const app = client.calls.find((c) => /:append/.test(c.url));
  assert.equal(app.idempotent, false);
  const writes = () => client.calls.filter((c) => /batchUpdate|:append/.test(c.url)).length;
  const before = writes();
  await assert.rejects(byName.get('sheet_write').run({ target: 'sheetBaaaa', cells: { A1: 'x' } }), (e) => e.code === 'READ_ONLY' && /Editor/.test(e.message));
  assert.equal(writes(), before);
  await assert.rejects(byName.get('sheet_write').run({ target: 'sheet1aaaa' }), /cells hoặc append/);
});

test('drive_move: đổi tên và chuyển folder; đích không canAddChildren → READ_ONLY; file Viewer → READ_ONLY', async () => {
  const { byName, client } = tools();
  const out = await byName.get('drive_move').run({ target: 'sheet1aaaa', new_name: 'TC_login_v2', to: 'rootAaaaa' });
  assert.equal(out, '✓ TC_login_v2 → Test Run');
  const patch = client.calls.find((c) => c.method === 'PATCH');
  assert.match(patch.url, /addParents=rootAaaaa/);
  assert.doesNotMatch(patch.url, /removeParents=/, 'chuyển vào chính folder hiện tại: không gỡ parent nào');
  assert.equal(client.gets.get('sheet1aaaa'), 2, 'parents lấy lại từ Drive, không dùng cache');
  await assert.rejects(byName.get('drive_move').run({ target: 'sheet1aaaa', to: 'rootBaaaa' }), (e) => e.code === 'READ_ONLY');
  await assert.rejects(byName.get('drive_move').run({ target: 'sheet1aaaa', to: 'sheetBaaaa' }), /không phải folder/);
  await assert.rejects(byName.get('drive_move').run({ target: 'sheetBaaaa', new_name: 'y' }), (e) => e.code === 'READ_ONLY');
  await assert.rejects(byName.get('drive_move').run({ target: 'sheet1aaaa' }), /new_name hoặc to/);
});

test('shortcut trong folder ghi được trỏ tới file Viewer: sheet_write và drive_move đều READ_ONLY', async () => {
  const extra = { shortRWaa: { id: 'shortRWaa', name: 'KPI link', mimeType: 'application/vnd.google-apps.shortcut', parents: ['rootAaaaa'], shortcutDetails: { targetId: 'sheetBaaaa' }, capabilities: RW } };
  const { byName, client } = tools('readwrite', fakeClient({ extra }));
  await assert.rejects(byName.get('sheet_write').run({ target: 'shortRWaa', cells: { A1: 'x' } }), (e) => e.code === 'READ_ONLY');
  await assert.rejects(byName.get('drive_move').run({ target: 'shortRWaa', new_name: 'y' }), (e) => e.code === 'READ_ONLY');
  await assert.rejects(byName.get('drive_move').run({ target: 'shortRWaa', to: 'rootAaaaa' }), (e) => e.code === 'READ_ONLY');
  assert.equal(client.calls.some((c) => c.method === 'PATCH' || /batchUpdate|:append/.test(c.url)), false);
});
```

6. Trong hai test `drive_move` dùng `SUB`, đổi regex `/^✓ TC_login → test-run\/…\/Sub/` thành `/^✓ TC_login → Sub/`.

7. Test `drive_create: folder/doc/sheet …`: sau khi thay địa chỉ ở mục 3, câu kiểm `READ_ONLY` cho `parent: 'rootBaaaa'` giữ nguyên.

- [ ] **Step 2: Chạy test, xác nhận hỏng**

Run: `node --test test/render.test.mjs test/tools.test.mjs`
Expected: FAIL. `buildTools` vẫn đọc `folders.length` khi `folders` là `undefined` nên ném TypeError, và test `AccessError` của render hỏng.

- [ ] **Step 3: Cài đặt**

`src/render.mjs`:
- Xoá hàm `renderFolders`.
- Trong `renderError`, thay `if (err?.name === 'ScopeError') return \`✗ ${msg}\`;` bằng `if (err?.name === 'AccessError') return \`✗ ${msg}\`;`.

`src/tools.mjs`:
- Comment đầu file:

```js
// Năm tool MCP, trả VĂN BẢN THUẦN (không bọc JSON) để tiết kiệm token. Người dùng gửi link,
// tool mở thẳng link đó; quyền theo share trên Drive (access.mjs): Editor ghi được, Viewer chỉ
// đọc. Không tool nào đụng tới hệ thống file của máy.
```

- Import:
  - bỏ dòng `scope.mjs` và `renderFolders`;
  - thêm `import { AccessError, createAccess } from './access.mjs';`.
- `const target = { type: 'string', description: 'Google URL or id.' };`
- Thay phần đầu `buildTools`, tới hết `const hasWrite = …;`, bằng:

```js
/**
 * @param {object} ctx
 * @param {() => object} ctx.getClient   client đã dựng (lazy, cache ở server)
 * @param {'readonly'|'readwrite'} ctx.mode  khoá an toàn chung; readonly thì ẩn tool ghi
 */
export function buildTools({ getClient, mode = 'readwrite', now = Date.now }) {
  let meta = null;
  let access = null;
  const ctx = () => {
    const client = getClient();
    meta ??= createMetaStore({ client, now });
    access ??= createAccess({ meta, mode });
    return { client, meta, access };
  };
```

- `drive_ls`:

```js
      description: 'List a folder\'s contents (folder URL or id), one line per item.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { ...target, description: 'Folder URL or id.' },
          query: { type: 'string', description: 'Name contains.' },
          limit: { type: 'integer', description: 'Default 30, max 200.' },
          page: { type: 'string', description: 'next token.' },
        },
        required: ['path'],
        additionalProperties: false,
      },
      async run(args) {
        const { client, access } = ctx();
        const { fileId, meta: m } = await access.resolve(args.path);
        if (m.mimeType !== MIME.FOLDER) throw new AccessError('NOT_FOUND', `"${m.name}" không phải folder. Dùng drive_read để đọc.`);
        const max = Math.min(Math.max(Number(args.limit) || 30, 1), 200);
        const { files, nextPageToken } = await listFiles(client, { folderId: fileId, nameContains: args.query ?? null, max, pageToken: args.page ?? null });
        return renderLs({ title: m.name, access: access.accessOf(m), items: files, total: files.length, next: nextPageToken });
      },
```

- `drive_read.run`: đổi `c.scope.resolve` thành `c.access.resolve`.

- `sheet_write`:
  - description: `'Write cells {"L5":"PASS"} and/or append rows to a Google Sheet (needs Editor).'`
  - Trong `run`, thay 3 dòng dựng ctx, resolve và assertWrite bằng:

```js
        const { client, meta, access } = ctx();
        const { fileId, gid, meta: m } = await access.resolve(args.target);
        access.assertCanEdit(m);
```

- `drive_create`:
  - description: `'Create a folder, Google Doc (markdown) or Google Sheet (CSV/TSV) in a folder (needs Editor).'`
  - Trong `run`, thay các dòng dựng ctx, resolve, assertWrite và kiểm folder bằng:

```js
        const { client, meta, access } = ctx();
        const { fileId: parentId, meta: pm } = await access.resolve(args.parent);
        if (pm.mimeType !== MIME.FOLDER) throw new Error(`"${pm.name}" không phải folder.`);
        access.assertCanAddChildren(pm);
```

  - Xoá dòng `scope.invalidateAll();`, giữ `meta.invalidate(parentId);`.

- `drive_move`:
  - description: `'Rename a file and/or move it to another folder (needs Editor).'`
  - `to: { ...target, description: 'Destination folder URL or id.' }`
  - `run`:

```js
      async run(args) {
        if (!args.new_name && !args.to) throw new Error('Cần new_name hoặc to.');
        const { client, meta, access } = ctx();
        const { fileId, meta: m } = await access.resolve(args.target);
        access.assertCanEdit(m);
        let dest = null;
        if (args.to) {
          const r = await access.resolve(args.to);
          if (r.meta.mimeType !== MIME.FOLDER) throw new Error(`"${r.meta.name}" không phải folder.`);
          access.assertCanAddChildren(r.meta);
          dest = r;
        }
        let removeParents = null;
        if (dest) {
          // parents trong cache có thể cũ (5 phút): lấy lại, nếu không file có thể nằm ở 2 folder.
          meta.invalidate(fileId);
          const fresh = await meta.file(fileId);
          if (!fresh.parents?.length) throw new Error(`Không xác định được folder hiện tại của "${m.name}" — không di chuyển.`);
          removeParents = fresh.parents.filter((p) => p !== dest.fileId).join(',') || null;
        }
        await updateFile(client, fileId, { name: args.new_name ?? null, addParents: dest?.fileId ?? null, removeParents });
        meta.invalidate(fileId);
        return `✓ ${args.new_name ?? m.name}${dest ? ` → ${dest.meta.name}` : ''}`;
      },
```

- Dòng cuối của `buildTools`: `return mode === 'readwrite' ? all : all.filter((t) => !t.write);`

- [ ] **Step 4: Chạy test, xác nhận qua**

Run: `node --test test/access.test.mjs test/render.test.mjs test/tools.test.mjs`
Expected: PASS. Nếu test schema báo vượt 700 token thì rút ngắn description, không sửa ngưỡng.

- [ ] **Step 5: Commit**

```bash
git add src/render.mjs src/tools.mjs test/render.test.mjs test/tools.test.mjs
git commit -m "feat(tools): 5 tool mở thẳng link, quyền theo share; buildTools({ mode })

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: MCP server theo `mode`; `instructions`

**Files:**
- Modify: `server/index.mjs`
  - import ở dòng 27;
  - `buildState` (dòng 82–114);
  - `refreshStateIfChanged`;
  - mọi chỗ dùng `folderError`.
- Modify: `src/instructions.mjs`
- Test: `test/mcp-server.test.mjs`

**Interfaces:**
- Consumes:
  - `buildTools({ getClient, mode })` (Task 2);
  - `modeFromConfig` (Task 1).
- Produces:
  - state của server có `mode` thay cho `folders`, `hasWrite`, `folderError`;
  - khi `mode` đổi, server gửi `notifications/tools/list_changed`.

- [ ] **Step 1: Viết lại test**

Các chỗ cần sửa trong `test/mcp-server.test.mjs`:

1. Test `server đọc config ở thư mục trung lập…`:
   - bỏ dòng `folders: [...]`, config chỉ còn `clientEmail` và `privateKey`;
   - đổi thông điệp assert thành `'config không có mode → readwrite, phải có tool ghi'`.

2. Thay test `mặc định (chưa có folder write)…` bằng:

```js
test('không có config: readonly, KHÔNG lộ tool ghi', async () => {
  const { msgs } = await talk([INIT, { jsonrpc: '2.0', id: 1, method: 'tools/list' }]);
  const names = msgs.find((m) => m.id === 1).result.tools.map((t) => t.name);
  assert.deepEqual(names, ['drive_ls', 'drive_read'], 'model không được thấy tool ghi');
});

test('config v0.4.0 còn mode readonly + folders, có GDRIVE_FOLDERS: chạy bình thường, bỏ qua cả hai, chỉ 2 tool', async () => {
  const home = mkdtempSync(join(tmpdir(), 'gdrive-mcp-home-'));
  writeConfig(home, { mode: 'readonly', folders: [{ id: 'f1aaaaaaaa', name: 'run', access: 'write' }] });
  const { msgs, code } = await talk([INIT, { jsonrpc: '2.0', id: 1, method: 'tools/list' }], { home, env: { GDRIVE_FOLDERS: 'ci=f2aaaaaaaa:write' } });
  assert.equal(code, 0);
  assert.deepEqual(msgs.find((m) => m.id === 1).result.tools.map((t) => t.name), ['drive_ls', 'drive_read']);
});
```

3. Test `lỗi của tool trả về isError…`:
   - thay `writeConfig(home, { folders: [...] })` bằng `writeConfig(home, { mode: 'readonly' })`;
   - `target: 'x'` và regex `/không phải URL Google hợp lệ/` giữ nguyên: `parseGoogleUrl` ném lỗi trước khi gọi mạng.

4. Test `config đổi folder read → write…`:
   - đổi tên thành `'config đổi mode readonly → readwrite: ping bắn list_changed, tools/list có tool ghi'`;
   - lần ghi đầu dùng `writeConfig(home, { mode: 'readonly' })`, lần sau dùng `writeConfig(home, { mode: 'readwrite' })`.

5. Test `config đổi credential nhưng folder vẫn read…`:
   - đổi tên thành `'config đổi credential nhưng mode vẫn readonly: không bắn list_changed và tools/list vẫn không có tool ghi'`;
   - hai lần ghi lần lượt là `{ mode: 'readonly', clientEmail: 'old-sa@proj.iam.gserviceaccount.com' }` và `{ mode: 'readonly', clientEmail: 'rotated-sa@proj.iam.gserviceaccount.com' }`.

6. Xoá test `config đổi danh sách folder: scope dựng lại…` và test `config folders hỏng: server vẫn trả lời tools/list…`.

7. Phần `buildTools (không qua tiến trình con)`: xoá `FOLDERS_W` và `FOLDERS_R`, rồi thay 3 test bằng:

```js
test('buildTools: readwrite mở đủ 5 tool, readonly còn 2', () => {
  assert.equal(buildTools({ getClient: () => ({}), mode: 'readwrite' }).length, 5);
  assert.equal(buildTools({ getClient: () => ({}), mode: 'readonly' }).length, 2);
});

test('buildTools: mọi tool có schema hợp lệ và additionalProperties=false', () => {
  for (const t of buildTools({ getClient: () => ({}), mode: 'readwrite' })) {
    assert.equal(t.inputSchema.additionalProperties, false, `${t.name} phải chặn field lạ`);
    assert.equal(typeof t.run, 'function');
    assert.ok(t.description.length > 40, `${t.name}: mô tả quá ngắn để model chọn đúng tool`);
  }
});

test('buildTools: tool ghi được đánh dấu write=true', () => {
  const w = buildTools({ getClient: () => ({}), mode: 'readwrite' }).filter((t) => t.write).map((t) => t.name);
  assert.deepEqual(w.sort(), ['drive_create', 'drive_move', 'sheet_write']);
});

test('renderError: 404 của Drive → gợi ý share cho email service account', () => {
  const e = Object.assign(new Error('File not found: abc'), { code: 404 });
  assert.match(renderError(e, { email: 'sa@p.iam.gserviceaccount.com' }), /^✗ 404: chưa share cho sa@p\.iam\.gserviceaccount\.com \(Viewer để đọc, Editor để ghi\)/);
});
```

   Nếu đầu file chưa import `renderError` thì thêm `import { renderError } from '../src/render.mjs';`.

8. Thay test `tools/call trả văn bản thuần, lỗi phạm vi bắt đầu bằng ✗…` bằng:

```js
test('tools/call: lỗi bắt đầu bằng ✗, là isError, không bọc JSON', async () => {
  const home = mkdtempSync(join(tmpdir(), 'gdrive-mcp-home-'));
  writeConfig(home, { mode: 'readonly' });
  const { msgs } = await talk([INIT, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'drive_read', arguments: { target: 'x' } } }], { home });
  const r = msgs.find((m) => m.id === 1).result;
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /^✗ /);
  assert.doesNotMatch(r.content[0].text, /^\{/, 'không bọc JSON');
});
```

9. Test `initialize trả instructions…`: thêm sau các assert có sẵn:

```js
  assert.doesNotMatch(instructions, /folder add|alias/);
  assert.match(instructions, /Editor/);
```

- [ ] **Step 2: Chạy test, xác nhận hỏng**

Run: `node --test test/mcp-server.test.mjs`
Expected: FAIL. Server vẫn dựng tool theo `folders`, nên config chỉ có `clientEmail` không có tool ghi, và đổi `mode` không bắn `list_changed`.

- [ ] **Step 3: Cài đặt**

`server/index.mjs`:
- Dòng 27: `const { modeFromConfig } = await import('../src/access.mjs');`
- Thay `buildState` bằng:

```js
function buildState() {
  const cfgWithSource = readConfigWithSource();
  const mode = modeFromConfig(cfgWithSource?.config ?? null);
  const fingerprint = fingerprintForConfigs();
  // Đổi config (fingerprint đổi) thì dựng lại tools và cache metadata: credential có thể đã
  // đổi sang service account khác, quyền cũ trong cache không còn đúng.
  const next = {
    mode,
    client: null,
    tools: [],
    byName: new Map(),
    listPayload: { tools: [] },
    sourcePath: cfgWithSource?.path ?? null,
    fingerprint,
  };
  const getClient = () => {
    if (!next.client) next.client = createClient({ mode, retries: 4 });
    return next.client;
  };
  next.tools = buildTools({ getClient, mode });
  next.byName = new Map(next.tools.map((t) => [t.name, t]));
  next.listPayload = {
    tools: next.tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
  };
  return next;
}
```

- Trong `refreshStateIfChanged`: `const toolsChanged = next.mode !== state.mode;`
- Xoá mọi nhánh dùng `folderError`.
- Kiểm bằng `grep -n "folderError\|folders\|hasWrite\|loadFolders" server/index.mjs`, kết quả phải rỗng.

`src/instructions.mjs`:

```js
// Hướng dẫn gửi kèm `initialize` (trường MCP `instructions`). Ngắn và trung lập cho mọi
// client; bản đầy đủ nằm ở skills/gdrive/SKILL.md.

export const INSTRUCTIONS = `Google Drive via a service account. Pass the Google URL (or id) the user gives straight to a tool; it may be a file or a folder. Access follows Drive sharing: Editor = read/write, Viewer = read only.

Tools: drive_ls (folder contents), drive_read (any file: sheets as TSV with columns/where/offset/limit, docs as markdown), sheet_write (cells and/or append rows), drive_create (folder/doc/sheet), drive_move (rename/move). Write tools are hidden in readonly mode.

Read big sheets in pages: follow next=<offset> in the first line. Prefer columns/where over reading everything.

Errors start with ✗. 404 or 403 means it is not shared with the service account email shown: ask the user to share it (Viewer to read, Editor to write). "Chỉ đọc" means the service account is not Editor there. Never ask the user to paste key file contents.`;
```

- [ ] **Step 4: Chạy test, xác nhận qua**

Run: `node --test test/mcp-server.test.mjs test/tools.test.mjs test/access.test.mjs`
Expected: PASS. Test `instructions` vẫn kiểm giới hạn dưới 1,5 KB; chuỗi trên khoảng 1 KB.

- [ ] **Step 5: Commit**

```bash
git add server/index.mjs src/instructions.mjs test/mcp-server.test.mjs
git commit -m "feat(server): tool theo mode trong config, bỏ danh sách folder; instructions mới

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: CLI, `status`, `init`; xoá module folder; bench

**Files:**
- Modify: `src/cli-scope.mjs` (cả file)
- Modify: `bin/cli.mjs`
  - import ở dòng 12, 23, 24;
  - HELP ở dòng 81–88;
  - dòng 142–157;
  - `cmdLs` (khoảng dòng 252–285);
  - `case 'folder'` ở dòng 417.
- Modify: `src/status.mjs`
  - import ở dòng 19, 21;
  - khối 1a (dòng 84–98);
  - khối gọi thật (khoảng dòng 142–150).
- Modify: `src/init.mjs` (dòng 125–138)
- Modify: `bench/tokens.mjs:21-24`
- Delete: `src/folders.mjs`, `src/folder-cli.mjs`, `src/scope.mjs`, `test/folders.test.mjs`, `test/folder-cli.test.mjs`, `test/scope.test.mjs`
- Test: `test/cli-scope.test.mjs` (viết lại), `test/install.test.mjs`, `test/credentials.test.mjs`, `test/mcp-server.test.mjs`

**Interfaces:**
- Consumes: `modeFromConfig`, `READONLY_HINT` (Task 1).
- Produces: `resolveCliMode({ flags = {}, cfg = null, needWrite = false }) → 'readonly'|'readwrite'`. Nếu cần ghi mà đang `readonly` thì ném lỗi có `exitCode = 3`.

- [ ] **Step 1: Viết test hỏng**

Thay toàn bộ `test/cli-scope.test.mjs` bằng:

```js
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
```

`test/install.test.mjs`: thay test `init: chạy lại với key khác / --adc giữ nguyên folders…` bằng test dưới đây. `baseFlags` ở dòng 50 có `mode: 'readonly'` và các test cũ dựa vào đó, nên giữ nguyên `baseFlags`; test mới bỏ khoá này bằng destructuring.

```js
test('init: mặc định readwrite; xoá khoá folders cũ, giữ khoá khác; readonly vẫn chọn được và được giữ', async () => {
  await sandbox(async ({ home, keyFile, env }) => {
    const logs = [];
    const log = (l) => logs.push(l);
    const { mode: _ignored, ...noMode } = baseFlags(keyFile);
    await runInit(noMode, { home, log, env });
    assert.equal(readConfig(home, env).mode, 'readwrite');
    assert.doesNotMatch(logs.join('\n'), /folder add/);

    writeConfig({ ...readConfig(home, env), folders: [{ id: 'f1aaaaaaaa', name: 'run', access: 'write' }], extra: 'giữ' }, home, env);
    const other = join(home, 'other.json');
    writeFileSync(other, KEY_JSON.replace('test-sa@', 'other-sa@'));
    await runInit({ yes: true, 'sa-json': other, 'no-test': true }, { home, log, env });
    let cfg = readConfig(home, env);
    assert.equal(cfg.folders, undefined, 'folders không còn dùng → xoá');
    assert.equal(cfg.extra, 'giữ');
    assert.equal(cfg.clientEmail, 'other-sa@proj-test.iam.gserviceaccount.com');
    assert.equal(cfg.mode, 'readwrite');

    await runInit({ yes: true, mode: 'readonly', 'no-test': true }, { home, log, env });
    assert.equal(readConfig(home, env).mode, 'readonly');

    await runInit({ yes: true, adc: true, 'no-test': true }, { home, log, env });
    cfg = readConfig(home, env);
    assert.equal(cfg.mode, 'readonly', 'chạy lại không truyền --mode thì giữ mode cũ');
    assert.equal(cfg.useAdc, true);
    assert.equal(cfg.privateKey, undefined, 'chuyển sang ADC thì bỏ private key');
    assert.equal(cfg.clientEmail, undefined);
  });
});
```

`test/credentials.test.mjs`: thay test `status: liệt kê folder được phép…` bằng:

```js
test('status: không còn mục folder; khoá folders cũ được nhắc; readonly có gợi ý bật ghi', async () => {
  await sandbox(async ({ home }) => {
    writeLegacyConfig(home, { mode: 'readonly', folders: [{ id: 'f1aaaaaaaa', name: 'run', access: 'write' }] });
    const logs = [];
    await runStatus({ home, env: {}, log: (line) => logs.push(line) });
    const output = logs.join('\n');
    assert.doesNotMatch(output, /Folder được phép|Chưa có folder nào/);
    assert.match(output, /Khoá "folders" không còn dùng từ v0\.5\.0, có thể xoá\./);
    assert.match(output, /Chế độ: readonly — bật ghi: gdrive init --mode readwrite --yes/);
  });
});
```

`test/mcp-server.test.mjs`: thêm test sau, đặt ngay sau test `CLI write: lỗi --set…`:

```js
test('CLI folder: đã bỏ, in hướng dẫn và thoát mã 2', () => {
  const home = mkdtempSync(join(tmpdir(), 'gdrive-cli-folder-'));
  try {
    const r = spawnSync(process.execPath, [CLI, 'folder', 'add', 'abcdefghij'], { env: sandboxEnv(home), encoding: 'utf8' });
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /Lệnh "folder" đã bỏ ở v0\.5\.0: quyền lấy theo share trên Drive\./);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Chạy test, xác nhận hỏng**

Run: `node --test test/cli-scope.test.mjs test/install.test.mjs test/credentials.test.mjs test/mcp-server.test.mjs`
Expected: FAIL ở các test mới.

- [ ] **Step 3: Cài đặt**

Thay `src/cli-scope.mjs` bằng:

```js
// Chế độ ghi cho các lệnh CLI. Quyền trên từng file do Drive quyết định (share Editor/Viewer);
// ở đây chỉ còn khoá `mode` trong config, hoặc cờ --mode cho một lần chạy.

import { modeFromConfig, READONLY_HINT } from './access.mjs';

export function resolveCliMode({ flags = {}, cfg = null, needWrite = false }) {
  const mode = flags.mode ?? modeFromConfig(cfg);
  if (needWrite && mode !== 'readwrite') {
    const e = new Error(`Đang ở chế độ readonly nên lệnh này bị từ chối. ${READONLY_HINT} (hoặc thêm --mode readwrite cho lần chạy này)`);
    e.exitCode = 3;
    throw e;
  }
  return mode;
}
```

`bin/cli.mjs`:
- Dòng 12: `import { resolveCliMode } from '../src/cli-scope.mjs';`
- Xoá dòng 23 và 24 (`runFolder`, `loadFolders`).
- Bỏ `renderFolders` khỏi import từ `../src/render.mjs`. Nếu dòng import đó không còn tên nào thì xoá cả dòng.
- Thêm `import { parseGoogleUrl } from '../src/url.mjs';` nếu chưa có.
- HELP: xoá 3 dòng `gdrive folder …` (dòng 86–88).
- Thay dòng 142–157 bằng:

```js
function clientFor(flags, { needWrite = false } = {}) {
  const mode = resolveCliMode({ flags, cfg: readConfig(), needWrite });
  return createClient({ mode, retries: 2 });
}

/** CLI nhận URL hoặc id; quyền do Drive quyết định. Giữ tên cũ để không sửa chỗ gọi. */
async function scopedTarget(_client, input) {
  return parseGoogleUrl(input);
}
```

- `cmdLs`: thay đoạn từ `const folders = cliFolders();` tới hết `const { folderId } = listTarget;` bằng đoạn dưới. Phần `listFiles` và in kết quả phía dưới giữ nguyên. Khi `folderId = null`, lệnh liệt kê mọi thứ service account thấy, như trước v0.4.0.

```js
  const client = clientFor(flags);
  const folderId = target ? parseGoogleUrl(target).id : null;
```

- Dòng 417: thay `case 'folder': return runFolder(flags);` bằng:

```js
    case 'folder': {
      const e = new Error('Lệnh "folder" đã bỏ ở v0.5.0: quyền lấy theo share trên Drive.');
      e.exitCode = 2;
      throw e;
    }
```

  Đọc hàm `main` để chắc lỗi có `exitCode` được in ra stderr rồi `process.exit(e.exitCode)`, giống lỗi `Thiếu --set` của `cmdWrite`. Nếu `main` xử lý khác thì làm theo cách của `main`.

`src/status.mjs`:
- Xoá import `loadFolders` và `NO_FOLDERS_MESSAGE`. Thêm `import { modeFromConfig, READONLY_HINT } from './access.mjs';`.
- Thay khối `// 1a. Danh sách folder được phép…` (từ comment tới hết `catch`) bằng:

```js
  // 1a. Khoá của v0.4.0, không còn tác dụng.
  if (cfg && Object.hasOwn(cfg, 'folders')) log(`${WARN} Khoá "folders" không còn dùng từ v0.5.0, có thể xoá.`);
```

- Thay ``log(`${OK} Chế độ: ${cfg.mode ?? 'readonly'}`);`` bằng:

```js
    const effective = modeFromConfig(cfg);
    log(`${OK} Chế độ: ${effective}${effective === 'readonly' ? ` — ${READONLY_HINT}` : ''}`);
```

- Khối gọi thật: thay `const mode = cfg?.mode ?? 'readonly';` bằng `const mode = modeFromConfig(cfg);`.

`src/init.mjs`, thay dòng 125–128 bằng:

```js
    const mode = (flags.mode ?? existing?.mode) === 'readonly' ? 'readonly' : 'readwrite';
    // Giữ các khoá khác của config cũ; thay credential và mode. `folders` (v0.4.0) không còn dùng.
    const { clientEmail: _e, privateKey: _k, projectId: _p, useAdc: _a, mode: _m, folders: _f, ...keep } = existing ?? {};
    const cfgFile = writeConfig({ ...keep, mode, useAdc, ...(credentials ?? {}) }, home, env);
```

Giữ nguyên khối log Windows/chmod. Thay dòng log chế độ và 2 dòng `hasFolders` bằng:

```js
    log(`   Chế độ: ${mode}${mode === 'readonly' ? ' — tool ghi bị ẩn khỏi client AI' : ' — ghi được ở nơi service account là Editor'}`);
```

`bench/tokens.mjs`, dòng 21–24:

```js
  const schema = JSON.stringify(
    buildTools({ getClient: () => null, mode: 'readwrite' }).map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
  );
```

Xoá file:

```bash
git rm src/folders.mjs src/folder-cli.mjs src/scope.mjs test/folders.test.mjs test/folder-cli.test.mjs test/scope.test.mjs
```

Kiểm không còn tham chiếu:

```bash
grep -rn "folders\.mjs\|folder-cli\|scope\.mjs\|loadFolders\|renderFolders\|ScopeError\|NO_FOLDERS\|findChild\|cliFolders\|assertCliQueryAllowed\|resolveCliTarget\|resolveCliListTarget" src bin server bench test
```

Expected: không có kết quả nào.

- [ ] **Step 4: Chạy toàn bộ test**

Run: `node --test && node bench/tokens.mjs`
Expected: PASS toàn bộ; bench in schema dưới 700 và thoát 0.

- [ ] **Step 5: Commit**

```bash
git add -A src bin bench test
git commit -m "feat(cli)!: bỏ lệnh folder và danh sách folder; init mặc định readwrite

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Tài liệu và bump 0.5.0

**Files:**
- Modify: `README.md`, `skills/gdrive/SKILL.md`, `skills/gdrive-setup/SKILL.md`, `CHANGELOG.md`, `SECURITY.md`, `CONTRIBUTING.md`
- Modify version:
  - `package.json`;
  - `.claude-plugin/plugin.json`;
  - `server/index.mjs` (`SERVER_INFO`);
  - dòng `version:` trong 2 file `SKILL.md`.
- Test: `test/version.test.mjs`

- [ ] **Step 1: Sửa test version**

Trong `test/version.test.mjs`, đổi chuỗi mong đợi `0.4.0` thành `0.5.0`.

Run: `node --test test/version.test.mjs`
Expected: FAIL.

- [ ] **Step 2: Bump 5 chỗ**

Đổi `0.4.0` thành `0.5.0` ở 5 chỗ:
- `package.json`;
- `.claude-plugin/plugin.json`;
- `SERVER_INFO` trong `server/index.mjs`;
- dòng `version:` của `skills/gdrive/SKILL.md`;
- dòng `version:` của `skills/gdrive-setup/SKILL.md`.

Run: `node --test test/version.test.mjs`
Expected: PASS.

- [ ] **Step 3: CHANGELOG**

Thêm ngay dưới `## [Chưa phát hành]`:

```markdown
## [0.5.0] - YYYY-MM-DD

### Thay đổi phá tương thích

- Bỏ danh sách folder. Chỉ cần gửi link. Quyền lấy theo share trên Drive:
  - service account là Editor thì đọc và ghi;
  - là Viewer thì chỉ đọc;
  - chưa được share thì tool báo lại kèm email cần share.

  Khoá `folders` và biến `GDRIVE_FOLDERS` bị bỏ qua.
- Bỏ lệnh `gdrive folder`.
- `drive_ls` cần link folder (tham số `path` bắt buộc). Bỏ địa chỉ dạng `alias/đường/dẫn`.
- `gdrive init` mặc định `--mode readwrite`. Config cũ đang `readonly` giữ nguyên; bật ghi bằng
  `gdrive init --mode readwrite --yes`.

### Đổi

- Tool ghi kiểm `capabilities.canEdit`/`canAddChildren` (có sẵn trong metadata) trước khi gọi API,
  nên báo "Chỉ đọc" thay vì để Drive trả 403 thô.
- Mở file không còn lần theo folder cha, nên bớt 1 đến vài request cho mỗi file mới.
- `gdrive ls --query` dùng lại được.
```

Thay `YYYY-MM-DD` bằng ngày commit, rồi cập nhật link cuối file:

```markdown
[Chưa phát hành]: https://github.com/sdc-ren/gdrive-cli/compare/v0.5.0...develop
[0.5.0]: https://github.com/sdc-ren/gdrive-cli/compare/v0.4.0...v0.5.0
```

- [ ] **Step 4: README, SKILL, SECURITY, CONTRIBUTING**

Tìm các chỗ cần sửa:

```bash
grep -n "folder add\|folder list\|folder set\|folder remove\|GDRIVE_FOLDERS\|\"folders\"\|alias\|folder được phép\|ngoài phạm vi" README.md skills/*/SKILL.md SECURITY.md CONTRIBUTING.md
```

README:
- Xoá phần khai báo folder, ví dụ config có `folders`, đoạn `GDRIVE_FOLDERS`, và mục `gdrive folder`.
- Viết lại luồng dùng: cài, chạy `gdrive init --sa-json <file>`, share file hoặc folder cho email service account, rồi gửi link cho AI.
- Thêm mục "Quyền":

  | Share cho email service account | AI làm được |
  |---|---|
  | Editor | đọc, ghi ô, append, tạo, đổi tên, di chuyển |
  | Viewer / Commenter | chỉ đọc |
  | Không share | báo lỗi kèm email cần share |
  | `mode: readonly` trong config | chỉ đọc ở mọi nơi, tool ghi bị ẩn |

- Thêm cảnh báo:
  - AI ghi được mọi thứ mà service account là Editor;
  - thứ gì chỉ cần đọc thì share quyền Viewer;
  - coi email service account là tài khoản riêng của AI.
- Thêm mục "Nâng cấp từ v0.4.0":
  - khoá `folders` không còn tác dụng, xoá hay giữ đều được;
  - muốn ghi thì chạy `gdrive init --mode readwrite --yes`;
  - lệnh `gdrive folder` đã bỏ;
  - `drive_ls` cần link folder.
- Đổi các ví dụ dùng `alias/path` sang link hoặc id.

`skills/gdrive/SKILL.md`:
- Truyền nguyên link người dùng gửi.
- Gặp 404/403 thì nhờ người dùng share cho email service account.
- Gặp "Chỉ đọc" thì báo cần quyền Editor.
- Bỏ `folder add` và alias.

`skills/gdrive-setup/SKILL.md`:
- Bỏ bước `folder add`.
- Thêm bước "share file hoặc folder cho email service account, chọn Editor nếu muốn AI ghi".

`SECURITY.md`:
- Mục "Những thứ được tính là lỗ hổng": thay gạch đầu dòng "Phạm vi folder bị vượt qua…" bằng:

```markdown
- Ghi được khi config đang `mode: readonly`.
- Tool đọc hoặc ghi được file không share cho service account.
```

- Mục "Ngoài phạm vi": đổi "tự thêm folder với `--access write`" thành "tự share quyền Editor".
- Bảng phiên bản: `0.5.x | Có`, `< 0.5 | Không`.

`CONTRIBUTING.md`:
- Thay đoạn "Mọi truy cập đi qua danh sách folder…" bằng:

```markdown
Quyền do Drive quyết định qua share (`src/access.mjs`): Editor thì ghi, Viewer thì đọc. Tool ghi
kiểm `capabilities` trước khi gọi API và bị ẩn khi config `mode: readonly`.
```

- Bảng cấu trúc: đổi dòng `src/folders.mjs, src/scope.mjs` thành `src/access.mjs | Phân giải link, kiểm quyền ghi, mode`.
- Mục phát hành: đổi ví dụ `v0.4.0` thành `v0.5.0`.

Chạy skill `humanizer:humanizer` trên các đoạn README mới viết, theo yêu cầu của người dùng.

- [ ] **Step 5: Kiểm và commit**

Run: `node --test && node bench/tokens.mjs`
Expected: PASS.

Chạy lại lệnh `grep` ở Step 4. Kết quả chỉ được còn ở mục nâng cấp của README và trong CHANGELOG.

```bash
git add README.md CHANGELOG.md SECURITY.md CONTRIBUTING.md skills package.json .claude-plugin/plugin.json server/index.mjs test/version.test.mjs
git commit -m "docs: v0.5.0 — quyền theo share, hướng dẫn nâng cấp; bump 0.5.0

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Kiểm chứng trên Drive thật, đo request

**Files:**
- Modify: `docs/superpowers/specs/2026-10-02-share-based-access-design.md` (thêm mục "Kết quả kiểm chứng")

Config thật nằm ở `~/.claude/plugins/data/gdrive-gdrive-cli/config.json`, đang `mode: readonly`. **Không** sửa file này. Phần ghi chỉ chạy khi người dùng đồng ý, và chạy với `GDRIVE_CONFIG_DIR` trỏ tới một bản sao trong scratchpad đã đổi sang `mode: readwrite`.

- [ ] **Step 1: Đọc**

Viết một script tạm trong scratchpad. Script gửi lần lượt các frame sau vào `node server/index.mjs`:
- `initialize`;
- `tools/list`;
- `tools/call drive_ls { path: 'https://drive.google.com/drive/folders/1xmedZmMAN7at08zCYDgy5l4WjKC6cwrV' }`;
- `tools/call drive_read { target: <id một file trong đó> }`;
- `tools/call drive_read { target: '1AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' }`.

Chạy với `GDRIVE_DEBUG=1` để đếm request trên stderr.

Expected:
- `tools/list` có 2 tool, vì config đang readonly.
- `drive_ls` ra `# gdriver (read) · N` kèm danh sách.
- Id không tồn tại ra `✗ 404: chưa share cho <email> …`.
- Mở folder lần đầu tốn đúng 1 request metadata và 1 request list.

- [ ] **Step 2: Ghi (hỏi người dùng trước)**

Hỏi người dùng ba điều:
- có cho chạy thử ghi trong `gdriver` không;
- có Google Sheet trống nào để ghi không;
- có mục nào đang share quyền Viewer để thử không.

Nếu đồng ý thì chạy:
- `drive_create { parent: <link gdriver>, name: 'gdrive-v05-verify', kind: 'folder' }` → `✓ folder …`
- `drive_move { target: <id vừa tạo>, new_name: 'gdrive-v05-verified' }` → `✓ gdrive-v05-verified`
- Nếu có Sheet thử: `sheet_write { target: <url>, cells: { A1: 'v0.5' }, append: [['ok']] }` → `✓ …: 1 cells, +1 rows`
- Nếu có mục Viewer: `drive_create` vào đó → `✗ Chỉ đọc: …`

Xong thì xoá bản sao config trong scratchpad. Báo người dùng các folder thử còn lại để họ tự xoá, vì service account không xoá file.

- [ ] **Step 3: Đo và ghi kết quả**

Đo:
- token schema ở `readwrite` và `readonly`, bằng tiktoken `o200k_base`, theo cách đã dùng trong `docs/superpowers/specs/2026-10-01-measurements.md`;
- số request khi đọc một sheet theo link, lần đầu và lần hai, so với v0.4.0.

Ghi bảng vào spec, mục mới "Kết quả kiểm chứng (<ngày>)". Nếu README có bảng số thì cập nhật luôn.

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/specs/2026-10-02-share-based-access-design.md README.md
git commit -m "docs: kết quả kiểm chứng v0.5.0 trên Drive thật

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Self-review

- **Spec phủ đủ:**
  - Mục 1:
    - capabilities → Task 1;
    - `mode` → Task 1, 3, 4;
    - `folders` và `GDRIVE_FOLDERS` → Task 3, 4;
    - lệnh `folder` → Task 4.
  - Mục 2:
    - 5 tool, `drive_ls` cần `path`, kiểm quyền ghi → Task 2;
    - tool theo `mode`, instructions → Task 3;
    - quy tắc My Drive giữ nguyên qua test `drive_create` cũ → Task 2;
    - lỗi 404 → Task 1, 3.
  - Mục 3 (CLI) → Task 4.
  - Mục 4 (bảng file) → Task 1–4.
  - Mục 5: test nằm trong từng task; kiểm chứng thật → Task 6.
  - Mục 6 (tài liệu) → Task 5.
- **Tên nhất quán.** Các tên sau dùng giống nhau ở mọi task:
  - `createAccess({ meta, mode })` với `resolve`, `accessOf`, `assertCanEdit`, `assertCanAddChildren`;
  - `modeFromConfig`, `AccessError`, `READONLY_HINT`;
  - `buildTools({ getClient, mode })`, `resolveCliMode({ flags, cfg, needWrite })`.
- **Review Focus:**
  - (1) Task 2, test shortcut;
  - (2) Task 3, test config v0.4.0;
  - (3) Task 1, test thiếu capabilities;
  - (4) Task 2, test `drive_ls` nhận link file;
  - (5) Task 1 (404 ném nguyên) và Task 3 (`renderError`).
