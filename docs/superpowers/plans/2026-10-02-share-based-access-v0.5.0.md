# Kế hoạch triển khai v0.5.0: quyền theo share trên Drive, bỏ danh sách folder

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Service account được share gì thì AI dùng được nấy: Editor thì đọc/ghi, Viewer thì chỉ đọc. Không còn bước khai báo folder.

**Architecture:** Thay lớp `scope.mjs` (danh sách folder + lần theo folder cha) bằng `access.mjs`. Lớp mới làm ba việc:
- liệt kê "gốc" bằng `drives.list` và `files.list sharedWithMe`, cache 5 phút;
- phân giải URL, id hoặc `tên-gốc/đường/dẫn`;
- kiểm tra quyền ghi bằng `capabilities.canEdit`/`canAddChildren` lấy từ cache metadata.

Khoá `mode` trong config thành công tắc an toàn chung. `readwrite` là mặc định mới của `init`. Lệnh `gdrive folder` và các module danh sách folder bị xoá.

**Tech Stack:** Node.js >= 18.17, chỉ API có sẵn, test bằng `node --test`.

**Spec:** `docs/superpowers/specs/2026-10-02-share-based-access-design.md`

## Global Constraints

- Node.js >= 18.17; không thêm dependency.
- Stdout của MCP server chỉ chứa frame JSON-RPC.
- Private key chỉ nằm trong đúng một file config, mode 600; không in ra log, kết quả tool, hay config của client.
- Drive là nơi quyết định quyền cuối cùng; kiểm tra phía client chỉ để báo lỗi rõ và chặn trước khi gọi API ghi.
- `mode: readonly` thì chỉ có `drive_ls` và `drive_read`, token xin scope `*.readonly`. `mode: readwrite`, hoặc có config mà thiếu `mode`, thì có đủ 5 tool. Không có config thì là `readonly`.
- Giữ bộ chặn công thức `IMPORT*`/`IMAGE` (`src/sheet-guard.mjs`) không đổi.
- Tổng schema tool dưới 700 token ước lượng (`ceil(bytes/3.5)`), CI báo đỏ nếu vượt.
- Đường dẫn dùng `path.join`; test chạy được trên Windows (CRLF, `%APPDATA%`).
- Test không gọi mạng, không đọc config thật (HOME tạm, `client.api` hoặc `fetch` giả).
- Commit theo Conventional Commits, kết thúc bằng `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Nhánh `feat/share-based-access` (đã tách từ `develop`); PR nhắm vào `develop`.

## Review Focus

1. **Tên gốc trông giống id** (vd. folder tên `Packflow_Test_Artifacts`, khớp `[A-Za-z0-9_-]{8,}`). Đọc như id gặp 404 thì phải rơi về khớp tên gốc, không báo "chưa share". Test ở Task 2.
2. **Hai gốc trùng tên.** Phải báo `AMBIGUOUS` kèm cả hai id, không chọn bừa một cái. Test ở Task 2.
3. **Metadata vào cache từ `findChild`** (đi theo `tên-gốc/đường/dẫn`) **phải có `capabilities.canEdit`**. Nếu thiếu, `sheet_write` từ chối nhầm file ghi được. Test ở Task 1 và Task 4.
4. **Config v0.4.0 còn `mode: readonly` cùng `folders`.** Server phải chạy, bỏ qua `folders`, chỉ có 2 tool. `status` gợi ý cách bật ghi. Test ở Task 5 và Task 6.
5. **Shortcut nằm trong folder ghi được, trỏ tới file chỉ đọc.** Quyền phải lấy theo file đích, nên `sheet_write` bị `READ_ONLY`. Test ở Task 4.

---

## Thứ tự và phụ thuộc

| Task | Nội dung | Phụ thuộc |
|---|---|---|
| 1 | `drive.mjs`: `listSharedWithMe`, `listDrives`, `canEdit` trong `FILE_FIELDS`; `meta.mjs` thêm capabilities | — |
| 2 | `access.mjs` (mới): `modeFromConfig`, `createAccess` | 1 |
| 3 | `render.mjs`: `renderRoots`, `renderError` cho `AccessError` | 2 |
| 4 | `tools.mjs` dùng `access`, `buildTools({ getClient, mode })` | 2, 3 |
| 5 | `server/index.mjs` theo `mode`, `instructions.mjs`, test server | 4 |
| 6 | CLI: bỏ `folder`, `cli-scope` rút gọn, `ls` liệt kê gốc, `status`, `init`; xoá module folder; bench | 2, 3, 4 |
| 7 | Tài liệu: README, SKILL ×2, CHANGELOG, SECURITY, CONTRIBUTING; bump 0.5.0 | 1–6 |
| 8 | Kiểm chứng trên Drive thật, đo token | 1–7 |

---

### Task 1: `drive.mjs` liệt kê gốc; capabilities trong metadata

**Files:**
- Modify: `src/drive.mjs` (`FILE_FIELDS` dòng 23–25; thêm 2 hàm sau `listFiles`)
- Modify: `src/meta.mjs:8` (`META_FIELDS`)
- Test: `test/drive.test.mjs`

**Interfaces:**
- Produces:
  - `listSharedWithMe(client, { max = 1000, pageToken = null } = {}) → Promise<{ files: Array<{id,name,mimeType,modifiedTime?,size?,driveId?,capabilities}>, nextPageToken: string|null }>`
  - `listDrives(client) → Promise<Array<{ id, name, capabilities }>>`
  - `FILE_FIELDS` có `canEdit` trong `capabilities(...)`.
  - `META_FIELDS === 'id,name,mimeType,size,parents,driveId,modifiedTime,webViewLink,shortcutDetails,capabilities(canEdit,canAddChildren)'`

- [ ] **Step 1: Viết test hỏng**

Thêm vào `test/drive.test.mjs`. Sửa dòng import đầu file thành:

```js
import { createFolder, downloadFile, exportFile, FILE_FIELDS, listDrives, listSharedWithMe, transferTimeoutMs, updateFile, uploadFile } from '../src/drive.mjs';
import { META_FIELDS } from '../src/meta.mjs';
```

Thêm cuối file:

```js
test('listSharedWithMe: q sharedWithMe + trashed=false, lấy capabilities, đủ cờ all-drives', async () => {
  const c = fakeClient({ files: [{ id: 'f1', name: 'gdriver' }], nextPageToken: 'n2' });
  const res = await listSharedWithMe(c, { pageToken: 'p1' });
  assert.deepEqual(res, { files: [{ id: 'f1', name: 'gdriver' }], nextPageToken: 'n2' });
  const url = decodeURIComponent(c.calls[0].url.replace(/\+/g, ' '));
  assert.match(url, /\/drive\/v3\/files\?/);
  assert.match(url, /q=sharedWithMe = true and trashed = false/);
  assert.match(url, /capabilities\(canEdit,canAddChildren\)/);
  assert.match(url, /pageSize=1000/);
  assert.match(url, /pageToken=p1/);
  assert.match(url, /includeItemsFromAllDrives=true/);
  assert.match(url, /supportsAllDrives=true/);
});

test('listDrives: gọi drives.list, trả mảng (rỗng khi API không có drives)', async () => {
  const c = fakeClient({ drives: [{ id: 'd1', name: 'Team', capabilities: { canAddChildren: true } }] });
  assert.deepEqual(await listDrives(c), [{ id: 'd1', name: 'Team', capabilities: { canAddChildren: true } }]);
  assert.match(c.calls[0].url, /\/drive\/v3\/drives\?/);
  assert.match(decodeURIComponent(c.calls[0].url), /capabilities\(canAddChildren\)/);
  assert.deepEqual(await listDrives(fakeClient({})), []);
});

test('metadata mang capabilities.canEdit ở cả files.get (META_FIELDS) lẫn files.list (FILE_FIELDS)', () => {
  assert.match(META_FIELDS, /capabilities\(canEdit,canAddChildren\)/);
  assert.match(FILE_FIELDS, /capabilities\([^)]*canEdit[^)]*\)/);
});
```

- [ ] **Step 2: Chạy test, xác nhận hỏng**

Run: `node --test test/drive.test.mjs`
Expected: FAIL. Import `listDrives`/`listSharedWithMe` không tồn tại (SyntaxError: does not provide an export named).

- [ ] **Step 3: Cài đặt**

Trong `src/drive.mjs`, sửa `FILE_FIELDS`:

```js
export const FILE_FIELDS =
  'id,name,mimeType,size,modifiedTime,webViewLink,webContentLink,driveId,parents,' +
  'capabilities(canAddChildren,canDownload,canEdit),exportLinks,shortcutDetails';
```

Thêm ngay sau hàm `listFiles`:

```js
const ROOT_FIELDS = 'id,name,mimeType,modifiedTime,size,driveId,capabilities(canEdit,canAddChildren)';

/**
 * File và folder được share trực tiếp cho service account. Đây là "gốc" của những gì nó thấy
 * ngoài Shared Drive. Đo thật 2026-10-02: 5 folder, khoảng 950 ms.
 */
export async function listSharedWithMe(client, { max = 1000, pageToken = null } = {}) {
  const data = await client.api({
    url: `${BASE}/files${buildQuery({
      q: 'sharedWithMe = true and trashed = false',
      fields: `nextPageToken,files(${ROOT_FIELDS})`,
      pageSize: Math.min(Math.max(max, 1), 1000),
      pageToken,
      ...LIST_PARAMS,
    })}`,
  });
  return { files: data.files ?? [], nextPageToken: data.nextPageToken ?? null };
}

/** Shared Drive mà service account là thành viên. */
export async function listDrives(client) {
  const data = await client.api({
    url: `${BASE}/drives${buildQuery({ fields: 'drives(id,name,capabilities(canAddChildren))', pageSize: 100 })}`,
  });
  return data.drives ?? [];
}
```

Trong `src/meta.mjs` sửa dòng 8:

```js
export const META_FIELDS = 'id,name,mimeType,size,parents,driveId,modifiedTime,webViewLink,shortcutDetails,capabilities(canEdit,canAddChildren)';
```

- [ ] **Step 4: Chạy test, xác nhận qua**

Run: `node --test test/drive.test.mjs`
Expected: PASS toàn bộ.

- [ ] **Step 5: Commit**

```bash
git add src/drive.mjs src/meta.mjs test/drive.test.mjs
git commit -m "feat(drive): liệt kê mục được share và Shared Drive; metadata mang canEdit

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: `access.mjs` — gốc, phân giải địa chỉ, kiểm quyền ghi

**Files:**
- Create: `src/access.mjs`
- Test: `test/access.test.mjs`

**Interfaces:**
- Consumes: `listSharedWithMe`, `listDrives` (Task 1); `createTtlCache` từ `src/cache.mjs`; `parseGoogleUrl` từ `src/url.mjs`; đối tượng `meta` của `createMetaStore` (`file(id)`, `findChild(parentId, name)`).
- Produces:
  - `MIME_SHARED_DRIVE = 'shared-drive'`
  - `READONLY_HINT = 'bật ghi: gdrive init --mode readwrite --yes'`
  - `class AccessError extends Error { name = 'AccessError'; code: 'READ_ONLY'|'NOT_FOUND'|'AMBIGUOUS' }`
  - `modeFromConfig(cfg) → 'readonly'|'readwrite'`
  - `createAccess({ client, meta, mode = 'readwrite', now = Date.now, ttlMs = 300000 })` trả:
    - `mode`
    - `roots({ query?, limit?, offset? }) → Promise<{ items: Array<{id,name,mimeType,access:'read'|'write'}>, total, next: number|null }>`
    - `resolve(input) → Promise<{ fileId, meta, gid }>`
    - `accessOf(meta) → 'read'|'write'`
    - `assertCanEdit(meta)`, `assertCanAddChildren(meta)` (ném `AccessError('READ_ONLY')`)
    - `invalidate()`

- [ ] **Step 1: Viết test hỏng**

Tạo `test/access.test.mjs`:

```js
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { AccessError, createAccess, MIME_SHARED_DRIVE, modeFromConfig } from '../src/access.mjs';

const FOLDER = 'application/vnd.google-apps.folder';
const SHEET = 'application/vnd.google-apps.spreadsheet';
const SHORTCUT = 'application/vnd.google-apps.shortcut';
const RW = { canEdit: true, canAddChildren: true };
const RO = { canEdit: false, canAddChildren: false };

// Gốc được share: gdriverAAA (Editor), viewOnly1 (Viewer), Packflow_Test_Artifacts (tên giống id),
// hai gốc trùng tên "Trung". Shared Drive: sd1 (thành viên ghi được).
const FILES = {
  gdriverAAA: { id: 'gdriverAAA', name: 'gdriver', mimeType: FOLDER, capabilities: RW },
  subAAAAAAA: { id: 'subAAAAAAA', name: 'bao cao', mimeType: FOLDER, parents: ['gdriverAAA'], capabilities: RW },
  sheetAAAAA: { id: 'sheetAAAAA', name: 'KPI', mimeType: SHEET, parents: ['subAAAAAAA'], capabilities: RW },
  viewOnly1: { id: 'viewOnly1', name: 'Rồng Việt SPEC', mimeType: FOLDER, capabilities: RO },
  roSheet01: { id: 'roSheet01', name: 'spec', mimeType: SHEET, parents: ['viewOnly1'], capabilities: RO },
  packRoot1: { id: 'packRoot1', name: 'Packflow_Test_Artifacts', mimeType: FOLDER, capabilities: RW },
  trungAAAA: { id: 'trungAAAA', name: 'Trung', mimeType: FOLDER, capabilities: RW },
  trungBBBB: { id: 'trungBBBB', name: 'Trung', mimeType: FOLDER, capabilities: RO },
  shortAAAA: { id: 'shortAAAA', name: 'link', mimeType: SHORTCUT, parents: ['gdriverAAA'], shortcutDetails: { targetId: 'roSheet01' } },
  brokenSc1: { id: 'brokenSc1', name: 'hong', mimeType: SHORTCUT, parents: ['gdriverAAA'] },
};
const SHARED = ['gdriverAAA', 'viewOnly1', 'packRoot1', 'trungAAAA', 'trungBBBB'];

function fakes({ drives = [{ id: 'sd1', name: 'Team Drive', capabilities: { canAddChildren: true } }], sharedPages = null } = {}) {
  const calls = [];
  const client = {
    calls,
    async api({ url }) {
      calls.push(url);
      if (/\/drive\/v3\/drives\?/.test(url)) return { drives };
      if (/sharedWithMe/.test(decodeURIComponent(url.replace(/\+/g, ' ')))) {
        if (sharedPages) {
          const token = new URL(url).searchParams.get('pageToken');
          return sharedPages[token ?? 'first'];
        }
        return { files: SHARED.map((id) => FILES[id]) };
      }
      throw new Error(`fake: ${url}`);
    },
  };
  const metaCalls = [];
  const meta = {
    calls: metaCalls,
    async file(id) {
      metaCalls.push(`file:${id}`);
      if (!FILES[id]) throw Object.assign(new Error('File not found'), { code: 404 });
      return FILES[id];
    },
    async findChild(parentId, name) {
      metaCalls.push(`child:${parentId}/${name}`);
      return Object.values(FILES).find((f) => (f.parents ?? []).includes(parentId) && f.name === name) ?? null;
    },
  };
  return { client, meta };
}

test('modeFromConfig: không config → readonly; thiếu mode → readwrite; readonly giữ nguyên', () => {
  assert.equal(modeFromConfig(null), 'readonly');
  assert.equal(modeFromConfig({ clientEmail: 'x' }), 'readwrite');
  assert.equal(modeFromConfig({ mode: 'readwrite' }), 'readwrite');
  assert.equal(modeFromConfig({ mode: 'readonly', folders: [{ id: 'a', name: 'b', access: 'write' }] }), 'readonly');
});

test('roots: gộp Shared Drive + sharedWithMe, nhãn theo capabilities', async () => {
  const { client, meta } = fakes();
  const access = createAccess({ client, meta });
  const { items, total, next } = await access.roots();
  assert.equal(total, 6);
  assert.equal(next, null);
  assert.deepEqual(items[0], { id: 'sd1', name: 'Team Drive', mimeType: MIME_SHARED_DRIVE, access: 'write' });
  assert.deepEqual(items.find((r) => r.id === 'gdriverAAA').access, 'write');
  assert.deepEqual(items.find((r) => r.id === 'viewOnly1').access, 'read');
});

test('roots: mode readonly ép mọi nhãn thành read', async () => {
  const { client, meta } = fakes();
  const { items } = await createAccess({ client, meta, mode: 'readonly' }).roots();
  assert.ok(items.every((r) => r.access === 'read'));
});

test('roots: query lọc không phân biệt hoa thường, limit/offset cắt và trả next', async () => {
  const { client, meta } = fakes();
  const access = createAccess({ client, meta });
  assert.deepEqual((await access.roots({ query: 'TRUNG' })).items.map((r) => r.id), ['trungAAAA', 'trungBBBB']);
  const page1 = await access.roots({ limit: 4 });
  assert.equal(page1.items.length, 4);
  assert.equal(page1.next, 4);
  const page2 = await access.roots({ limit: 4, offset: 4 });
  assert.deepEqual(page2.items.map((r) => r.id), ['trungAAAA', 'trungBBBB']);
  assert.equal(page2.next, null);
  assert.equal((await access.roots({ limit: 9999 })).items.length, 6, 'limit kẹp tối đa 200, không lỗi');
});

test('roots: cache 5 phút (gọi lại không tốn request), invalidate() xoá cache, hết TTL tải lại', async () => {
  let t = 0;
  const { client, meta } = fakes();
  const access = createAccess({ client, meta, now: () => t });
  await access.roots();
  await access.roots({ query: 'x' });
  assert.equal(client.calls.length, 2, 'drives + sharedWithMe, đúng một lần');
  access.invalidate();
  await access.roots();
  assert.equal(client.calls.length, 4);
  t = 5 * 60_000 + 1;
  await access.roots();
  assert.equal(client.calls.length, 6);
});

test('roots: sharedWithMe nhiều trang được đi hết', async () => {
  const sharedPages = {
    first: { files: [FILES.gdriverAAA], nextPageToken: 'p2' },
    p2: { files: [FILES.viewOnly1], nextPageToken: null },
  };
  const { client, meta } = fakes({ drives: [], sharedPages });
  const { items } = await createAccess({ client, meta }).roots();
  assert.deepEqual(items.map((r) => r.id), ['gdriverAAA', 'viewOnly1']);
});

test('resolve: id trần và URL đọc thẳng, không tải danh sách gốc', async () => {
  const { client, meta } = fakes();
  const access = createAccess({ client, meta });
  assert.equal((await access.resolve('sheetAAAAA')).fileId, 'sheetAAAAA');
  const r = await access.resolve('https://docs.google.com/spreadsheets/d/sheetAAAAA/edit#gid=7');
  assert.equal(r.fileId, 'sheetAAAAA');
  assert.equal(r.gid, '7');
  assert.equal(client.calls.length, 0);
});

test('resolve: tên-gốc/đường/dẫn có khoảng trắng và dấu', async () => {
  const { client, meta } = fakes();
  const access = createAccess({ client, meta });
  const r = await access.resolve('gdriver/bao cao/KPI');
  assert.equal(r.fileId, 'sheetAAAAA');
  assert.equal(r.gid, null);
  assert.equal((await access.resolve('Rồng Việt SPEC')).fileId, 'viewOnly1');
});

test('resolve: tên gốc giống id → 404 thì rơi về khớp tên gốc', async () => {
  const { client, meta } = fakes();
  const access = createAccess({ client, meta });
  assert.equal((await access.resolve('Packflow_Test_Artifacts')).fileId, 'packRoot1');
  assert.ok(meta.calls.includes('file:Packflow_Test_Artifacts'), 'đã thử như id trước');
});

test('resolve: id không share và không trùng tên gốc → giữ lỗi 404 ban đầu', async () => {
  const { client, meta } = fakes();
  await assert.rejects(createAccess({ client, meta }).resolve('khongShare1'), (e) => e.code === 404);
});

test('resolve: hai gốc trùng tên → AMBIGUOUS kèm cả hai id', async () => {
  const { client, meta } = fakes();
  await assert.rejects(createAccess({ client, meta }).resolve('Trung/x'), (e) => e instanceof AccessError && e.code === 'AMBIGUOUS' && /trungAAAA/.test(e.message) && /trungBBBB/.test(e.message));
});

test('resolve: tên gốc không có / đoạn đường dẫn không có → NOT_FOUND', async () => {
  const { client, meta } = fakes();
  const access = createAccess({ client, meta });
  await assert.rejects(access.resolve('Khong Co/a'), (e) => e.code === 'NOT_FOUND' && /drive_ls/.test(e.message));
  await assert.rejects(access.resolve('gdriver/khong-co'), (e) => e.code === 'NOT_FOUND' && /khong-co/.test(e.message));
  await assert.rejects(access.resolve('gdriver/bao cao/KPI/con'), (e) => e.code === 'NOT_FOUND' && /không phải folder/.test(e.message));
});

test('resolve: shortcut giải về file đích; shortcut hỏng → NOT_FOUND', async () => {
  const { client, meta } = fakes();
  const access = createAccess({ client, meta });
  const r = await access.resolve('shortAAAA');
  assert.equal(r.fileId, 'roSheet01');
  assert.equal(r.meta.capabilities.canEdit, false);
  await assert.rejects(access.resolve('brokenSc1'), (e) => e.code === 'NOT_FOUND');
});

test('assertCanEdit / assertCanAddChildren / accessOf theo capabilities và mode', () => {
  const { client, meta } = fakes();
  const rw = createAccess({ client, meta });
  rw.assertCanEdit(FILES.sheetAAAAA);
  rw.assertCanAddChildren(FILES.gdriverAAA);
  assert.equal(rw.accessOf(FILES.sheetAAAAA), 'write');
  assert.equal(rw.accessOf(FILES.roSheet01), 'read');
  assert.throws(() => rw.assertCanEdit(FILES.roSheet01), (e) => e.code === 'READ_ONLY' && /Editor/.test(e.message) && /spec/.test(e.message));
  assert.throws(() => rw.assertCanAddChildren(FILES.viewOnly1), (e) => e.code === 'READ_ONLY');
  assert.throws(() => rw.assertCanEdit({ name: 'x' }), (e) => e.code === 'READ_ONLY', 'thiếu capabilities → coi như chỉ đọc');
  const ro = createAccess({ client, meta, mode: 'readonly' });
  assert.equal(ro.accessOf(FILES.sheetAAAAA), 'read');
  assert.throws(() => ro.assertCanEdit(FILES.sheetAAAAA), (e) => e.code === 'READ_ONLY' && /readonly/.test(e.message));
});
```

- [ ] **Step 2: Chạy test, xác nhận hỏng**

Run: `node --test test/access.test.mjs`
Expected: FAIL, `Cannot find module '.../src/access.mjs'`.

- [ ] **Step 3: Cài đặt**

Tạo `src/access.mjs`:

```js
// Quyền theo share trên Drive (v0.5.0). Service account mở được file nào thì AI dùng được file
// đó; ghi được hay không do `capabilities` Drive trả về quyết định. Kiểm tra ở đây để báo lỗi
// dễ hiểu và chặn trước khi gọi API ghi. Drive vẫn là nơi chặn cuối cùng.
//
// "Gốc" là những gì service account thấy ở cấp trên cùng: Shared Drive nó là thành viên, và
// file/folder share trực tiếp cho nó. `drive_ls` không tham số liệt kê gốc, và địa chỉ dạng
// `tên-gốc/đường/dẫn` đi từ đó.

import { createTtlCache } from './cache.mjs';
import { listDrives, listSharedWithMe } from './drive.mjs';
import { parseGoogleUrl } from './url.mjs';

const MIME_FOLDER = 'application/vnd.google-apps.folder';
const MIME_SHORTCUT = 'application/vnd.google-apps.shortcut';
const BARE_ID_RE = /^[A-Za-z0-9_-]{8,}$/;
const TTL_MS = 5 * 60_000;
const MAX_ROOTS = 1000;

export const MIME_SHARED_DRIVE = 'shared-drive';
export const READONLY_HINT = 'bật ghi: gdrive init --mode readwrite --yes';

export class AccessError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'AccessError';
    this.code = code;
  }
}

const isNotFound = (err) => err?.status === 404 || Number(err?.code) === 404;

/** Không có config: readonly (chưa có credential thì cũng không ghi được). Có mà thiếu `mode`: readwrite. */
export function modeFromConfig(cfg) {
  if (!cfg) return 'readonly';
  return cfg.mode === 'readonly' ? 'readonly' : 'readwrite';
}

export function createAccess({ client, meta, mode = 'readwrite', now = Date.now, ttlMs = TTL_MS }) {
  const cache = createTtlCache({ ttlMs, now });
  const writable = (flag) => mode === 'readwrite' && flag === true;

  async function loadShared() {
    const out = [];
    let pageToken = null;
    do {
      const page = await listSharedWithMe(client, { pageToken });
      out.push(...page.files);
      pageToken = page.nextPageToken;
    } while (pageToken && out.length < MAX_ROOTS);
    return out.slice(0, MAX_ROOTS);
  }

  async function loadRoots() {
    const [drives, shared] = await Promise.all([listDrives(client), loadShared()]);
    return [
      ...drives.map((d) => ({ id: d.id, name: d.name, mimeType: MIME_SHARED_DRIVE, access: writable(d.capabilities?.canAddChildren) ? 'write' : 'read' })),
      ...shared.map((f) => ({ id: f.id, name: f.name, mimeType: f.mimeType, access: writable(f.capabilities?.canEdit) ? 'write' : 'read' })),
    ];
  }
  const allRoots = () => cache.getOrLoad('roots', loadRoots);

  /** Metadata của `id`; shortcut thì trả metadata file đích. */
  async function target(id) {
    let m = await meta.file(id);
    if (m.mimeType === MIME_SHORTCUT) {
      const targetId = m.shortcutDetails?.targetId;
      if (!targetId) throw new AccessError('NOT_FOUND', `Shortcut "${m.name}" không có đích.`);
      m = await meta.file(targetId);
    }
    return { fileId: m.id, meta: m };
  }

  async function byRootName(raw) {
    const [first, ...rest] = raw.split('/');
    const segments = rest.filter(Boolean);
    const matches = (await allRoots()).filter((r) => r.name === first);
    if (matches.length > 1) {
      throw new AccessError('AMBIGUOUS', `Có ${matches.length} mục tên "${first}": dùng id ${matches.map((r) => r.id).join(' hoặc ')}.`);
    }
    if (!matches.length) throw new AccessError('NOT_FOUND', `Không có mục nào tên "${first}" được share. Gọi drive_ls để xem.`);
    let current = { id: matches[0].id, mimeType: MIME_FOLDER };
    let walked = first;
    for (const segment of segments) {
      if (current.mimeType !== MIME_FOLDER) throw new AccessError('NOT_FOUND', `"${walked}" không phải folder.`);
      const child = await meta.findChild(current.id, segment);
      if (!child) throw new AccessError('NOT_FOUND', `Không có "${segment}" trong "${walked}".`);
      current = child;
      walked += `/${segment}`;
    }
    return { ...(await target(current.id)), gid: null };
  }

  function denyUnless(flag, m) {
    if (mode !== 'readwrite') throw new AccessError('READ_ONLY', `Đang ở chế độ readonly, không ghi. ${READONLY_HINT}`);
    if (flag !== true) throw new AccessError('READ_ONLY', `Chỉ đọc: service account chưa có quyền Editor với "${m?.name ?? '?'}".`);
  }

  return {
    mode,

    async roots({ query = null, limit = 30, offset = 0 } = {}) {
      const all = await allRoots();
      const q = query ? String(query).toLowerCase() : null;
      const hit = q ? all.filter((r) => r.name.toLowerCase().includes(q)) : all;
      const lim = Math.min(Math.max(Number(limit) || 30, 1), 200);
      const off = Math.max(Number(offset) || 0, 0);
      return { items: hit.slice(off, off + lim), total: hit.length, next: off + lim < hit.length ? off + lim : null };
    },

    /** `input`: URL Google, id trần, hoặc `tên-gốc/đường/dẫn`. Xem spec mục 2 về thứ tự thử. */
    async resolve(input) {
      const raw = String(input ?? '').trim();
      if (raw.includes(':')) {
        const { id, gid } = parseGoogleUrl(raw);
        return { ...(await target(id)), gid };
      }
      if (!raw.includes('/') && BARE_ID_RE.test(raw)) {
        try {
          return { ...(await target(raw)), gid: null };
        } catch (err) {
          if (!isNotFound(err)) throw err;
          try {
            return await byRootName(raw);
          } catch (nameErr) {
            if (nameErr instanceof AccessError && nameErr.code === 'NOT_FOUND') throw err;
            throw nameErr;
          }
        }
      }
      return byRootName(raw);
    },

    accessOf: (m) => (writable(m?.capabilities?.canEdit) ? 'write' : 'read'),
    assertCanEdit: (m) => denyUnless(m?.capabilities?.canEdit, m),
    assertCanAddChildren: (m) => denyUnless(m?.capabilities?.canAddChildren, m),
    invalidate: () => cache.clear(),
  };
}
```

- [ ] **Step 4: Chạy test, xác nhận qua**

Run: `node --test test/access.test.mjs`
Expected: PASS toàn bộ 14 test.

- [ ] **Step 5: Commit**

```bash
git add src/access.mjs test/access.test.mjs
git commit -m "feat(access): quyền theo capabilities của Drive, gốc = Shared Drive + sharedWithMe

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: `render.mjs` — `renderRoots`, lỗi `AccessError`

**Files:**
- Modify: `src/render.mjs` (thay `renderFolders` dòng 38–41; nhánh `ScopeError` trong `renderError`)
- Test: `test/render.test.mjs` (thay test `renderFolders` ở dòng ~20–23)

**Interfaces:**
- Consumes: `MIME_SHARED_DRIVE`, `READONLY_HINT` (Task 2).
- Produces:
  - `renderRoots({ items, total, next = null, mode = 'readwrite' }) → string`
  - `renderError(err, { email })`: `AccessError` → `✗ <dòng đầu message>`.
  - `renderFolders` bị xoá.

- [ ] **Step 1: Viết test hỏng**

Trong `test/render.test.mjs`, đổi `renderFolders` thành `renderRoots` ở dòng import. Xoá test của `renderFolders` (đoạn assert `'# 2 folders\nd test-run (write) 1XyZ\nd bao-cao (read) 1AbC'`) và thay bằng:

```js
test('renderRoots: Shared Drive mã D, nhãn quyền, next; readonly có gợi ý; rỗng có hướng dẫn share', () => {
  const items = [
    { id: '0AAbc', name: 'Team Drive', mimeType: 'shared-drive', access: 'write' },
    { id: '1xmed', name: 'gdriver', mimeType: 'application/vnd.google-apps.folder', access: 'write' },
    { id: '1Def', name: 'Báo cáo tuần', mimeType: 'application/vnd.google-apps.spreadsheet', access: 'read' },
  ];
  assert.equal(
    renderRoots({ items, total: 5, next: 3 }),
    '# 5 shared · next=3\nD Team Drive (write) 0AAbc\nd gdriver (write) 1xmed\ns Báo cáo tuần (read) 1Def',
  );
  assert.equal(
    renderRoots({ items: items.slice(2), total: 1, mode: 'readonly' }).split('\n')[0],
    '# 1 shared · readonly — bật ghi: gdrive init --mode readwrite --yes',
  );
  assert.equal(renderRoots({ items: [], total: 0 }), '# 0 shared · share folder cho email service account (xem gdrive status)');
});

test('renderError: AccessError in dòng đầu với ✗', () => {
  const e = Object.assign(new Error('Chỉ đọc: service account chưa có quyền Editor với "KPI".\nchi tiết'), { name: 'AccessError', code: 'READ_ONLY' });
  assert.equal(renderError(e), '✗ Chỉ đọc: service account chưa có quyền Editor với "KPI".');
});
```

(Nếu `renderError` chưa có trong dòng import của file test thì thêm vào.)

- [ ] **Step 2: Chạy test, xác nhận hỏng**

Run: `node --test test/render.test.mjs`
Expected: FAIL, `does not provide an export named 'renderRoots'`.

- [ ] **Step 3: Cài đặt**

Trong `src/render.mjs`, thêm import:

```js
import { MIME_SHARED_DRIVE, READONLY_HINT } from './access.mjs';
```

Thay `renderFolders` bằng:

```js
export function renderRoots({ items, total, next = null, mode = 'readwrite' }) {
  if (!total) return '# 0 shared · share folder cho email service account (xem gdrive status)';
  const head = `# ${total} shared${mode === 'readonly' ? ` · readonly — ${READONLY_HINT}` : ''}${next !== null ? ` · next=${next}` : ''}`;
  const lines = items.map((r) => `${r.mimeType === MIME_SHARED_DRIVE ? 'D' : typeCode(r.mimeType, r.name)} ${r.name} (${r.access}) ${r.id}`);
  return [head, ...lines].join('\n');
}
```

Trong `renderError`, thay dòng `if (err?.name === 'ScopeError') return \`✗ ${msg}\`;` bằng:

```js
  if (err?.name === 'AccessError') return `✗ ${msg}`;
```

- [ ] **Step 4: Chạy test, xác nhận qua**

Run: `node --test test/render.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/render.mjs test/render.test.mjs
git commit -m "feat(render): renderRoots cho danh sách được share, lỗi AccessError

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

`bin/cli.mjs` và `src/tools.mjs` vẫn import `renderFolders` nên tới hết Task 6 suite đầy đủ chưa xanh. Ở các task 3–5 chỉ chạy file test của task đó.

---

### Task 4: `tools.mjs` dùng `access`

**Files:**
- Modify: `src/tools.mjs` (toàn file)
- Test: `test/tools.test.mjs` (fixture và các test liên quan phạm vi)

**Interfaces:**
- Consumes: `createAccess`, `AccessError` (Task 2); `renderRoots` (Task 3); `createMetaStore` (`src/meta.mjs`).
- Produces: `buildTools({ getClient, mode = 'readwrite', now = Date.now }) → Array<{ name, write, description, inputSchema, run }>`. Có `mode: 'readonly'` thì chỉ còn `drive_ls`, `drive_read`.

- [ ] **Step 1: Viết lại test**

Trong `test/tools.test.mjs`, thay khối từ `const FILES = {` đến hết hàm `tools` (dòng 11–75) bằng:

```js
const RW = { canEdit: true, canAddChildren: true };
const RO = { canEdit: false, canAddChildren: false };
// `shared: true` = gốc trả về từ sharedWithMe.
const FILES = {
  rootAaaaa: { id: 'rootAaaaa', name: 'Test Run', mimeType: FOLDER, parents: [], driveId: 'sd1', capabilities: RW, shared: true },
  rootCaaaa: { id: 'rootCaaaa', name: 'My Drive folder', mimeType: FOLDER, parents: [], capabilities: RW, shared: true },
  sheet1aaaa: { id: 'sheet1aaaa', name: 'TC_login', mimeType: GSHEET, parents: ['rootAaaaa'], modifiedTime: '2026-09-30T00:00:00Z', capabilities: RW },
  book1aaaa: { id: 'book1aaaa', name: 'report.xlsx', mimeType: XLSX, parents: ['rootAaaaa'], size: '2048', capabilities: RW },
  rootBaaaa: { id: 'rootBaaaa', name: 'Bao cao', mimeType: FOLDER, parents: [], capabilities: RO, shared: true },
  sheetBaaaa: { id: 'sheetBaaaa', name: 'KPI', mimeType: GSHEET, parents: ['rootBaaaa'], capabilities: RO },
};
```

Trong `fakeClient`, ngay đầu `async api(opts)` sau `const u = opts.url;`, thêm hai nhánh:

```js
      if (/drive\/v3\/drives\?/.test(u)) return { drives: [] };
      if (/sharedWithMe/.test(decodeURIComponent(u.replace(/\+/g, ' ')))) return { files: Object.values(all).filter((f) => f.shared), nextPageToken: null };
```

Nhánh list cũ (`if (/drive\/v3\/files\?/.test(u)) { ... }`) giữ nguyên, nhưng đổi dòng return để bỏ `capabilities` khi list. Lý do: mô phỏng `files.list` dùng `FILE_FIELDS`; Task 1 đã thêm `canEdit` vào đó nên vẫn giữ `capabilities`. Không đổi gì.

Thay `FOLDERS_RW`/`FOLDERS_RO`/`tools` bằng:

```js
const tools = (mode = 'readwrite', client = fakeClient()) => {
  const list = buildTools({ getClient: () => client, mode });
  return { client, byName: new Map(list.map((t) => [t.name, t])), names: list.map((t) => t.name) };
};
```

Thay các test dùng `FOLDERS_*` như sau. Giữ nguyên các test chỉ đổi lời gọi `tools(FOLDERS_RW…)` thành `tools()` và `tools(FOLDERS_RW, fakeClient(...))` thành `tools('readwrite', fakeClient(...))`, đồng thời đổi đường dẫn `test-run` thành `Test Run`, `bao-cao` thành `Bao cao`, `my-drive` thành `My Drive folder`. Các test phải viết lại hẳn:

```js
test('tool ghi có ở readwrite, ẩn ở readonly; schema gọn', () => {
  assert.deepEqual(tools().names, ['drive_ls', 'drive_read', 'sheet_write', 'drive_create', 'drive_move']);
  assert.deepEqual(tools('readonly').names, ['drive_ls', 'drive_read']);
  const bytes = JSON.stringify(buildTools({ getClient: () => null, mode: 'readwrite' }).map(({ name, description, inputSchema }) => ({ name, description, inputSchema }))).length;
  assert.ok(Math.ceil(bytes / 3.5) < 700, `schema ≈ ${Math.ceil(bytes / 3.5)} token`);
});

test('drive_ls không path: liệt kê gốc được share; có path: nội dung folder, nhãn theo canEdit', async () => {
  const { byName } = tools();
  assert.equal(await byName.get('drive_ls').run({}), '# 3 shared\nd Test Run (write) rootAaaaa\nd My Drive folder (write) rootCaaaa\nd Bao cao (read) rootBaaaa');
  assert.equal(await byName.get('drive_ls').run({ query: 'bao' }), '# 1 shared\nd Bao cao (read) rootBaaaa');
  assert.equal((await byName.get('drive_ls').run({ limit: 1, page: '1' })).split('\n')[0], '# 3 shared · next=2');
  const out = await byName.get('drive_ls').run({ path: 'Test Run' });
  assert.equal(out.split('\n')[0], '# Test Run (write) · 2');
  assert.ok(out.includes('s TC_login sheet1aaaa 2026-09-30'));
  assert.ok(out.includes('x report.xlsx book1aaaa 2KB'));
  assert.equal((await byName.get('drive_ls').run({ path: 'Bao cao' })).split('\n')[0], '# Bao cao (read) · 1');
});

test('drive_ls readonly: tiêu đề gợi ý bật ghi, mọi nhãn read', async () => {
  const { byName } = tools('readonly');
  const out = await byName.get('drive_ls').run({});
  assert.match(out.split('\n')[0], /readonly — bật ghi: gdrive init --mode readwrite --yes/);
  assert.doesNotMatch(out, /\(write\)/);
});

test('drive_read xlsx qua tên-gốc/đường/dẫn; file không share → lỗi 404', async () => {
  const { byName } = tools();
  const out = await byName.get('drive_read').run({ target: 'Test Run/report.xlsx' });
  assert.equal(out.split('\n')[0], '# report.xlsx › Data · tabs: Data · rows 1-1/1');
  assert.equal(out.split('\n')[2], '42');
  await assert.rejects(byName.get('drive_read').run({ target: 'khongShare1' }), (e) => e.code === 404);
});

test('sheet_write: cells → 1 batchUpdate, append → 1 append không idempotent; file Viewer bị READ_ONLY, không gọi API ghi', async () => {
  const { byName, client } = tools();
  const out = await byName.get('sheet_write').run({ target: 'sheet1aaaa', cells: { L5: 'PASS', L6: 'FAIL' }, append: [['TC9', 'PASS', '']] });
  assert.equal(out, '✓ Sheet1: 2 cells, +1 rows');
  const batch = client.calls.find((c) => /batchUpdate/.test(c.url));
  assert.deepEqual(batch.body.data.map((d) => d.range), ["'Sheet1'!L5", "'Sheet1'!L6"]);
  const app = client.calls.find((c) => /:append/.test(c.url));
  assert.equal(app.idempotent, false);
  const writesBefore = client.calls.filter((c) => /batchUpdate|:append/.test(c.url)).length;
  await assert.rejects(byName.get('sheet_write').run({ target: 'sheetBaaaa', cells: { A1: 'x' } }), (e) => e.code === 'READ_ONLY' && /Editor/.test(e.message));
  assert.equal(client.calls.filter((c) => /batchUpdate|:append/.test(c.url)).length, writesBefore);
  await assert.rejects(byName.get('sheet_write').run({ target: 'sheet1aaaa' }), /cells hoặc append/);
});

test('sheet_write qua đường dẫn: metadata lấy từ findChild vẫn có canEdit, ghi được', async () => {
  const { byName } = tools();
  assert.equal(await byName.get('sheet_write').run({ target: 'Test Run/TC_login', cells: { A1: 'x' } }), '✓ Sheet1: 1 cells, +0 rows');
});

test('drive_move: đổi tên và chuyển folder; đích không canAddChildren → READ_ONLY', async () => {
  const { byName, client } = tools();
  const out = await byName.get('drive_move').run({ target: 'sheet1aaaa', new_name: 'TC_login_v2', to: 'Test Run' });
  assert.match(out, /^✓ TC_login_v2 → Test Run/);
  const patch = client.calls.find((c) => c.method === 'PATCH');
  assert.match(patch.url, /addParents=rootAaaaa/);
  assert.doesNotMatch(patch.url, /removeParents=/, 'chuyển vào chính folder hiện tại: không gỡ parent nào');
  assert.equal(client.gets.get('sheet1aaaa'), 2, 'parents lấy lại từ Drive, không dùng cache');
  await assert.rejects(byName.get('drive_move').run({ target: 'sheet1aaaa', to: 'Bao cao' }), (e) => e.code === 'READ_ONLY');
  await assert.rejects(byName.get('drive_move').run({ target: 'sheet1aaaa', to: 'sheetBaaaa' }), /không phải folder/);
  await assert.rejects(byName.get('drive_move').run({ target: 'sheetBaaaa', new_name: 'y' }), (e) => e.code === 'READ_ONLY');
  await assert.rejects(byName.get('drive_move').run({ target: 'sheet1aaaa' }), /new_name hoặc to/);
});

test('drive_create làm mới danh sách gốc (cache gốc bị xoá)', async () => {
  const { byName, client } = tools();
  await byName.get('drive_ls').run({});
  const listsBefore = client.calls.filter((c) => /sharedWithMe/.test(decodeURIComponent(c.url.replace(/\+/g, ' ')))).length;
  await byName.get('drive_create').run({ parent: 'Test Run', name: 'Q4', kind: 'folder' });
  await byName.get('drive_ls').run({});
  assert.equal(client.calls.filter((c) => /sharedWithMe/.test(decodeURIComponent(c.url.replace(/\+/g, ' ')))).length, listsBefore + 1);
});

test('shortcut trong folder ghi được trỏ tới file Viewer: sheet_write và drive_move đều READ_ONLY', async () => {
  const extra = { shortRWaa: { id: 'shortRWaa', name: 'KPI link', mimeType: 'application/vnd.google-apps.shortcut', parents: ['rootAaaaa'], shortcutDetails: { targetId: 'sheetBaaaa' }, capabilities: RW } };
  const { byName, client } = tools('readwrite', fakeClient({ extra }));
  await assert.rejects(byName.get('sheet_write').run({ target: 'shortRWaa', cells: { A1: 'x' } }), (e) => e.code === 'READ_ONLY');
  await assert.rejects(byName.get('drive_move').run({ target: 'shortRWaa', new_name: 'y' }), (e) => e.code === 'READ_ONLY');
  await assert.rejects(byName.get('drive_move').run({ target: 'shortRWaa', to: 'Test Run' }), (e) => e.code === 'READ_ONLY');
  assert.equal(client.calls.some((c) => c.method === 'PATCH' || /batchUpdate|:append/.test(c.url)), false);
});
```

Trong test `drive_create: folder/doc/sheet …`, đổi lời gọi folder chỉ đọc thành `parent: 'Bao cao'`; câu kiểm `READ_ONLY` giữ nguyên.

Xoá hẳn 3 test không còn ý nghĩa:
- `drive_ls folder rỗng danh sách → NO_FOLDERS…`
- `drive_move: không đổi tên/di chuyển folder gốc trong danh sách`
- `folder rỗng: báo NO_FOLDERS trước khi dựng client…`

Test `drive_read xlsx: … OUT_OF_SCOPE` cũ được thay bằng test `drive_read xlsx qua tên-gốc/đường/dẫn…` ở trên.

Test `không tool nào có tham số đường dẫn trên máy`: đổi `folders: FOLDERS_RW` thành `mode: 'readwrite'`.

Trong 2 test `drive_move` dùng `SUB`, đổi `to: 'test-run/Sub'` thành `to: 'Test Run/Sub'` và regex `/^✓ TC_login → test-run\/…\/Sub/` thành `/^✓ TC_login → Sub/`. Thêm `capabilities: RW` vào `SUB.subAaaaaa`.

- [ ] **Step 2: Chạy test, xác nhận hỏng**

Run: `node --test test/tools.test.mjs`
Expected: FAIL. `buildTools` còn đọc `folders`: `folders.length` của `undefined` ném TypeError, hoặc ra `NO_FOLDERS`.

- [ ] **Step 3: Cài đặt**

Thay `src/tools.mjs`:
- Comment đầu file:

```js
// Năm tool MCP, trả VĂN BẢN THUẦN (không bọc JSON) để tiết kiệm token. Quyền theo share trên
// Drive (access.mjs): service account mở được thì đọc được, là Editor thì ghi được. Không tool
// nào đụng tới hệ thống file của máy.
```

- Import: bỏ `createScope, NO_FOLDERS_MESSAGE, ScopeError` và `renderFolders`, thêm:

```js
import { AccessError, createAccess } from './access.mjs';
import { renderDoc, renderLs, renderRoots, renderTable } from './render.mjs';
```

- Thay phần đầu `buildTools` (tới hết `const hasWrite = …`) bằng:

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
    access ??= createAccess({ client, meta, mode, now });
    return { client, meta, access };
  };
```

- `drive_ls`:

```js
      description: 'List what is shared with the service account (no path) or a folder\'s contents.',
      // inputSchema giữ nguyên
      async run(args) {
        const { client, access } = ctx();
        if (!args.path) {
          const res = await access.roots({ query: args.query ?? null, limit: args.limit ?? 30, offset: Number(args.page) || 0 });
          return renderRoots({ ...res, mode });
        }
        const { fileId, meta: m } = await access.resolve(args.path);
        if (m.mimeType !== MIME.FOLDER) throw new AccessError('NOT_FOUND', `"${m.name}" không phải folder. Dùng drive_read để đọc.`);
        const max = Math.min(Math.max(Number(args.limit) || 30, 1), 200);
        const { files, nextPageToken } = await listFiles(client, { folderId: fileId, nameContains: args.query ?? null, max, pageToken: args.page ?? null });
        return renderLs({ title: m.name, access: access.accessOf(m), items: files, total: files.length, next: nextPageToken });
      },
```

- `drive_read.run`: đổi `c.scope.resolve` thành `c.access.resolve`. Phần còn lại giữ nguyên.

- `sheet_write`:
  - description: `'Write cells {"L5":"PASS"} and/or append rows to a Google Sheet (needs Editor).'`
  - Trong `run`, thay 2 dòng resolve và assertWrite bằng:

```js
        const { client, meta, access } = ctx();
        const { fileId, gid, meta: m } = await access.resolve(args.target);
        access.assertCanEdit(m);
```

- `drive_create`:
  - description: `'Create a folder, Google Doc (markdown) or Google Sheet (CSV/TSV) in a folder you can edit.'`
  - Trong `run`:

```js
        const { client, meta, access } = ctx();
        const { fileId: parentId, meta: pm } = await access.resolve(args.parent);
        if (pm.mimeType !== MIME.FOLDER) throw new Error(`"${pm.name}" không phải folder.`);
        access.assertCanAddChildren(pm);
```

  - Thay `scope.invalidateAll();` bằng `access.invalidate();`.

- `drive_move`:
  - description: `'Rename a file and/or move it to another folder (needs Editor).'`
  - `to: { ...target, description: 'Destination folder.' }`
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
        access.invalidate();
        meta.invalidate(fileId);
        return `✓ ${args.new_name ?? m.name}${dest ? ` → ${dest.meta.name}` : ''}`;
      },
```

- Dòng cuối:

```js
  return mode === 'readwrite' ? all : all.filter((t) => !t.write);
```

- [ ] **Step 4: Chạy test, xác nhận qua**

Run: `node --test test/tools.test.mjs test/access.test.mjs`
Expected: PASS. Nếu test schema báo vượt 700 token thì rút ngắn description, không sửa ngưỡng.

- [ ] **Step 5: Commit**

```bash
git add src/tools.mjs test/tools.test.mjs
git commit -m "feat(tools): 5 tool theo quyền share, buildTools({ mode })

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: MCP server theo `mode`, `instructions`

**Files:**
- Modify: `server/index.mjs` (dòng 27 import; `buildState` dòng 82–114; `refreshStateIfChanged`)
- Modify: `src/instructions.mjs`
- Test: `test/mcp-server.test.mjs`

**Interfaces:**
- Consumes: `buildTools({ getClient, mode })` (Task 4), `modeFromConfig` (Task 2).
- Produces: state có `mode` thay cho `folders/hasWrite/folderError`; đổi `mode` thì server gửi `notifications/tools/list_changed`.

- [ ] **Step 1: Viết lại test**

Trong `test/mcp-server.test.mjs`:

1. Test `server đọc config ở thư mục trung lập…`: bỏ dòng `folders: [...]` (config chỉ còn `clientEmail`, `privateKey`). Thông báo assert đổi thành `'config không có mode → readwrite, phải có tool ghi'`.

2. Test `mặc định (chưa có folder write)…` đổi thành:

```js
test('không có config: readonly, KHÔNG lộ tool ghi', async () => {
  const { msgs } = await talk([INIT, { jsonrpc: '2.0', id: 1, method: 'tools/list' }]);
  const names = msgs.find((m) => m.id === 1).result.tools.map((t) => t.name);
  assert.deepEqual(names, ['drive_ls', 'drive_read'], 'model không được thấy tool ghi');
});

test('config v0.4.0 còn mode readonly + folders: chạy bình thường, bỏ qua folders, chỉ 2 tool', async () => {
  const home = mkdtempSync(join(tmpdir(), 'gdrive-mcp-home-'));
  writeConfig(home, { mode: 'readonly', folders: [{ id: 'f1aaaaaaaa', name: 'run', access: 'write' }] });
  const { msgs, code } = await talk([INIT, { jsonrpc: '2.0', id: 1, method: 'tools/list' }], { home, env: { GDRIVE_FOLDERS: 'ci=f2aaaaaaaa:write' } });
  assert.equal(code, 0);
  assert.deepEqual(msgs.find((m) => m.id === 1).result.tools.map((t) => t.name), ['drive_ls', 'drive_read']);
});
```

3. Test `lỗi của tool trả về isError…`: đổi `writeConfig(home, { folders: [...] })` thành `writeConfig(home, { mode: 'readonly' })`. Input `target: 'x'` không có `/`, không giống id nên sẽ đi nhánh tên gốc, và việc đó cần mạng. Đổi input thành `target: 'https://example.com/x'`. Đầu vào có `:` nên `parseGoogleUrl` ném lỗi ngay. Đổi regex assert thành `/Không tách được file id/`.

4. Test `config đổi folder read → write…` đổi tên thành `'config đổi mode readonly → readwrite: ping bắn list_changed, tools/list có tool ghi'`. Lần ghi đầu là `writeConfig(home, { mode: 'readonly' })`, lần sau là `writeConfig(home, { mode: 'readwrite' })`.

5. Test `config đổi credential nhưng folder vẫn read…` đổi tên thành `'config đổi credential nhưng mode vẫn readonly: không bắn list_changed…'`. Hai lần ghi là `{ mode: 'readonly', clientEmail: 'old-sa@…' }` rồi `{ mode: 'readonly', clientEmail: 'rotated-sa@…' }`.

6. Xoá test `config đổi danh sách folder: scope dựng lại…` và test `config folders hỏng: server vẫn trả lời tools/list…`.

7. Phần `buildTools (không qua tiến trình con)`: xoá `FOLDERS_W`, `FOLDERS_R`. Thay 3 test bằng:

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
```

8. Test `tools/call trả văn bản thuần, lỗi phạm vi bắt đầu bằng ✗…` đổi thành:

```js
test('tools/call trả văn bản thuần, lỗi bắt đầu bằng ✗ và là isError', async () => {
  const home = mkdtempSync(join(tmpdir(), 'gdrive-mcp-home-'));
  writeConfig(home, { mode: 'readonly' });
  const { msgs } = await talk([INIT, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'drive_read', arguments: { target: 'https://example.com/x' } } }], { home });
  const r = msgs.find((m) => m.id === 1).result;
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /^✗ /);
  assert.doesNotMatch(r.content[0].text, /^\{/, 'không bọc JSON');
});
```

9. Test `initialize trả instructions…`: thêm hai assert:

```js
  assert.doesNotMatch(instructions, /folder add/);
  assert.match(instructions, /Editor/);
```

Biến chứa chuỗi instructions trong test đó có thể tên khác `instructions`; dùng đúng tên biến có sẵn.

- [ ] **Step 2: Chạy test, xác nhận hỏng**

Run: `node --test test/mcp-server.test.mjs`
Expected: FAIL. Server vẫn dựng tool theo `folders`: config chỉ có `clientEmail` không ra tool ghi, và `mode` đổi không bắn `list_changed`.

- [ ] **Step 3: Cài đặt**

`server/index.mjs`:
- Dòng 27: thay `const { loadFolders } = await import('../src/folders.mjs');` bằng `const { modeFromConfig } = await import('../src/access.mjs');`.
- Thay `buildState`:

```js
function buildState() {
  const cfgWithSource = readConfigWithSource();
  const mode = modeFromConfig(cfgWithSource?.config ?? null);
  const fingerprint = fingerprintForConfigs();
  // State mới = tools mới = cache metadata và danh sách gốc mới: đổi config (fingerprint đổi)
  // thì dựng lại toàn bộ ở đây, vì credential có thể đã đổi sang service account khác.
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
- Tìm mọi chỗ còn dùng `state.folderError` hoặc `snapshot.folderError` (thường trong nhánh `tools/call`, chỗ ném lỗi cấu hình folder) và xoá nhánh đó. Kiểm bằng `grep -n "folderError\|folders\|hasWrite" server/index.mjs`; kết quả phải rỗng.

`src/instructions.mjs`:

```js
// Hướng dẫn gửi kèm `initialize` (trường MCP `instructions`). Ngắn và trung lập cho mọi
// client; bản đầy đủ nằm ở skills/gdrive/SKILL.md.

export const INSTRUCTIONS = `Google Drive via a service account. It sees what was shared with its email: Editor = read/write, Viewer = read only. Call drive_ls with no args first to see what is shared and the access of each item.

Tools: drive_ls (shared items / folder contents), drive_read (any file: sheets as TSV with columns/where/offset/limit, docs as markdown), sheet_write (cells and/or append rows), drive_create (folder/doc/sheet), drive_move (rename/move). Write tools are hidden in readonly mode.

Targets accept a Google URL, an id, or name/path/file starting from a shared item name (e.g. gdriver/reports/KPI). Read big sheets in pages: follow next=<offset> in the first line. Prefer columns/where over reading everything.

Errors start with ✗. 404 or 403 means the file is not shared with the service account email shown: ask the user to share it (Viewer to read, Editor to write). "Chỉ đọc" means the service account is not Editor there. Never ask the user to paste key file contents.`;
```

- [ ] **Step 4: Chạy test, xác nhận qua**

Run: `node --test test/mcp-server.test.mjs test/tools.test.mjs`
Expected: PASS. Test `instructions` vẫn kiểm giới hạn dưới 1,5 KB (`Buffer.byteLength`); chuỗi trên khoảng 1,1 KB.

- [ ] **Step 5: Commit**

```bash
git add server/index.mjs src/instructions.mjs test/mcp-server.test.mjs
git commit -m "feat(server): tool theo mode trong config, bỏ danh sách folder; instructions mới

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: CLI, `status`, `init`; xoá module folder; bench

**Files:**
- Modify: `src/cli-scope.mjs` (toàn file)
- Modify: `bin/cli.mjs`:
  - dòng 12, 23, 24 (import);
  - dòng 81–88 (HELP);
  - dòng 142–157 (`cliFolders`, `clientFor`, `scopedTarget`);
  - `cmdLs` (dòng ~252–285), `cmdPut` (dòng ~326), `case 'folder'` (dòng 417).
- Modify: `src/status.mjs` (import dòng 19, 21; khối 1a dòng 84–98; khối gọi thật dòng ~142–165)
- Modify: `src/init.mjs` (dòng 125–138)
- Modify: `bench/tokens.mjs:21-24`
- Delete: `src/folders.mjs`, `src/folder-cli.mjs`, `src/scope.mjs`, `test/folders.test.mjs`, `test/folder-cli.test.mjs`, `test/scope.test.mjs`
- Test: `test/cli-scope.test.mjs` (viết lại), `test/install.test.mjs`, `test/credentials.test.mjs`, `test/mcp-server.test.mjs` (thêm test CLI)

**Interfaces:**
- Consumes: `modeFromConfig`, `createAccess` (Task 2); `renderRoots` (Task 3); `createMetaStore`.
- Produces: `resolveCliMode({ flags = {}, cfg = null, needWrite = false }) → 'readonly'|'readwrite'` (ném lỗi `exitCode = 3` khi cần ghi mà đang readonly).

- [ ] **Step 1: Viết test hỏng**

Thay toàn bộ `test/cli-scope.test.mjs`:

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

Trong `test/install.test.mjs`, thay test `init: chạy lại với key khác / --adc giữ nguyên folders…` bằng:

```js
test('init: mặc định readwrite; xoá khoá folders cũ, giữ khoá khác; --mode readonly vẫn chọn được', async () => {
  await sandbox(async ({ home, keyFile, env }) => {
    const logs = [];
    const log = (l) => logs.push(l);
    const { mode: _ignored, ...noMode } = baseFlags(keyFile); // baseFlags có mode: 'readonly'
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

`baseFlags` (dòng 50 của `test/install.test.mjs`) giữ nguyên `mode: 'readonly'`: các test cũ dựa vào nó. Test mới bỏ khoá đó bằng destructuring như trên.

Trong `test/credentials.test.mjs`, thay test `status: liệt kê folder được phép…` bằng:

```js
test('status: không còn mục folder; khoá folders cũ được nhắc là bỏ được; readonly có gợi ý bật ghi', async () => {
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

Thêm vào `test/mcp-server.test.mjs`, sau test `CLI write: lỗi --set…`:

```js
test('CLI folder: đã bỏ, in hướng dẫn và thoát mã 2', () => {
  const home = mkdtempSync(join(tmpdir(), 'gdrive-cli-folder-'));
  try {
    const r = spawnSync(process.execPath, [CLI, 'folder', 'add', 'abcdefghij'], { env: sandboxEnv(home), encoding: 'utf8' });
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /Lệnh "folder" đã bỏ ở v0\.5\.0: quyền lấy theo share trên Drive\. Xem gdrive ls\./);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Chạy test, xác nhận hỏng**

Run: `node --test test/cli-scope.test.mjs test/install.test.mjs test/credentials.test.mjs test/mcp-server.test.mjs`
Expected: FAIL ở các test mới. `resolveCliMode` còn đọc `folders`; `init` mặc định `readonly`; `status` in mục folder; `folder` vẫn chạy.

- [ ] **Step 3: Cài đặt**

Thay `src/cli-scope.mjs`:

```js
// Chế độ ghi cho các lệnh CLI. Quyền trên từng file do Drive quyết định (share Editor/Viewer);
// ở đây chỉ còn khoá `mode` trong config hoặc cờ --mode cho một lần chạy.

import { modeFromConfig, READONLY_HINT } from './access.mjs';

export function resolveCliMode({ flags = {}, cfg = null, needWrite = false }) {
  const mode = flags.mode ?? modeFromConfig(cfg);
  if (needWrite && mode !== 'readwrite') {
    const e = new Error(`Đang ở chế độ readonly nên lệnh này bị từ chối. ${READONLY_HINT}   (hoặc thêm --mode readwrite cho lần chạy này)`);
    e.exitCode = 3;
    throw e;
  }
  return mode;
}
```

`bin/cli.mjs`:
- Dòng 12: `import { resolveCliMode } from '../src/cli-scope.mjs';`
- Xoá dòng 23 và 24 (`runFolder`, `loadFolders`).
- Thêm import:

```js
import { createAccess } from '../src/access.mjs';
import { createMetaStore } from '../src/meta.mjs';
```

- Trong import từ `../src/render.mjs`, thay `renderFolders` bằng `renderRoots`.
- HELP: xoá 3 dòng `gdrive folder …` (dòng 86–88). Sửa dòng mô tả `gdrive ls` để không còn nhắc folder được phép: `gdrive ls [url-folder]  Không có url: liệt kê mọi thứ đã share cho service account.`
- Thay dòng 142–157 bằng:

```js
function clientFor(flags, { needWrite = false } = {}) {
  const mode = resolveCliMode({ flags, cfg: readConfig(), needWrite });
  return createClient({ mode, retries: 2 });
}

/** CLI nhận URL hoặc id; quyền do Drive quyết định. */
async function scopedTarget(_client, input) {
  return parseGoogleUrl(input);
}
```

  (Giữ tên `scopedTarget` để không phải sửa mọi chỗ gọi. Nếu `parseGoogleUrl` chưa được import trong `bin/cli.mjs` thì thêm `import { parseGoogleUrl } from '../src/url.mjs';`.)
- Trong `cmdLs`, thay đoạn từ `const folders = cliFolders();` tới hết khối `if (listTarget.roots) { … }` và `const { folderId } = listTarget;` bằng:

```js
  const client = clientFor(flags);
  if (!target) {
    const access = createAccess({ client, meta: createMetaStore({ client }), mode: resolveCliMode({ flags, cfg: readConfig() }) });
    const res = await access.roots({ query: flags['name-contains'] ?? null, limit: Number(flags.max ?? 200) });
    if (flags.json) json({ roots: res.items });
    else out(renderRoots({ ...res, mode: access.mode }));
    return true;
  }
  const folderId = parseGoogleUrl(target).id;
```

- `cmdPut`: `(await scopedTarget(client, flags.folder, { write: true })).id` vẫn chạy được với `scopedTarget` mới; không sửa.
- Dòng 417: thay `case 'folder': return runFolder(flags);` bằng:

```js
    case 'folder': {
      const e = new Error('Lệnh "folder" đã bỏ ở v0.5.0: quyền lấy theo share trên Drive. Xem gdrive ls.');
      e.exitCode = 2;
      throw e;
    }
```

  Kiểm cách `main` in lỗi và đặt mã thoát: lỗi có `exitCode` phải ra stderr và `process.exit(e.exitCode)`, giống lỗi `--set` của `cmdWrite` đang làm. Nếu `main` làm khác thì theo đúng cách của `cmdWrite`.

`src/status.mjs`:
- Xoá import `loadFolders`, `NO_FOLDERS_MESSAGE`. Thêm `import { createAccess, modeFromConfig, READONLY_HINT } from './access.mjs';`.
- Thay khối `// 1a. Danh sách folder được phép …` (từ comment tới hết `catch`) bằng:

```js
  // 1a. Khoá cũ của v0.4.0: không còn tác dụng.
  if (cfg && Object.hasOwn(cfg, 'folders')) log(`${WARN} Khoá "folders" không còn dùng từ v0.5.0, có thể xoá.`);
```

- Dòng `log(\`${OK} Chế độ: ${cfg.mode ?? 'readonly'}\`)` thay bằng:

```js
    const effective = modeFromConfig(cfg);
    log(`${OK} Chế độ: ${effective}${effective === 'readonly' ? ` — ${READONLY_HINT}` : ''}`);
```

- Khối gọi thật: thay `const mode = cfg?.mode ?? 'readonly';` bằng `const mode = modeFromConfig(cfg);`. Sau dòng `log(\`${OK} Token OK — danh tính: ${email}\`);` thêm:

```js
      try {
        const { items, total } = await createAccess({ client, meta: null, mode }).roots({ limit: 200 });
        const writable = items.filter((r) => r.access === 'write').length;
        log(`${OK} Được share: ${total} mục, ghi được ${writable}`);
      } catch (listErr) {
        log(`${WARN} Không liệt kê được mục được share: ${String(listErr.message).split('\n')[0]}`);
      }
```

`src/init.mjs` dòng 125–138:

```js
    const mode = (flags.mode ?? existing?.mode) === 'readonly' ? 'readonly' : 'readwrite';
    // Giữ các khoá khác của config cũ; thay credential và mode. `folders` (v0.4.0) không còn dùng.
    const { clientEmail: _e, privateKey: _k, projectId: _p, useAdc: _a, mode: _m, folders: _f, ...keep } = existing ?? {};
    const cfgFile = writeConfig({ ...keep, mode, useAdc, ...(credentials ?? {}) }, home, env);
```

Giữ nguyên khối log Windows/chmod. Thay dòng log chế độ cùng 2 dòng `hasFolders` bằng:

```js
    log(`   Chế độ: ${mode}${mode === 'readonly' ? ' — tool ghi bị ẩn khỏi client AI' : ' — ghi được ở nơi service account là Editor'}`);
```

`bench/tokens.mjs`, sửa dòng 21–24:

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
grep -rn "folders\.mjs\|folder-cli\|scope\.mjs\|loadFolders\|renderFolders\|ScopeError\|NO_FOLDERS\|GDRIVE_FOLDERS" src bin server bench test
```

Expected: rỗng. Ngoại lệ được phép: chuỗi `GDRIVE_FOLDERS` trong test Task 5 (config v0.4.0 bị bỏ qua).

- [ ] **Step 4: Chạy toàn bộ test**

Run: `node --test && node bench/tokens.mjs`
Expected: toàn bộ PASS; bench in schema dưới 700 và thoát 0.

- [ ] **Step 5: Commit**

```bash
git add -A src bin bench test
git commit -m "feat(cli)!: bỏ lệnh folder; ls liệt kê mục được share; init mặc định readwrite

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Tài liệu và bump 0.5.0

**Files:**
- Modify: `README.md`, `skills/gdrive/SKILL.md`, `skills/gdrive-setup/SKILL.md`, `CHANGELOG.md`, `SECURITY.md`, `CONTRIBUTING.md`
- Modify version: `package.json`, `.claude-plugin/plugin.json`, `server/index.mjs` (`SERVER_INFO`), `version:` trong 2 file `SKILL.md`
- Test: `test/version.test.mjs`

- [ ] **Step 1: Sửa test version**

Trong `test/version.test.mjs`, đổi chuỗi phiên bản mong đợi `0.4.0` thành `0.5.0`.

Run: `node --test test/version.test.mjs`
Expected: FAIL (các file còn 0.4.0).

- [ ] **Step 2: Bump 5 chỗ**

Đổi `0.4.0` thành `0.5.0` trong:
- `package.json` (`"version"`);
- `.claude-plugin/plugin.json` (`"version"`);
- `server/index.mjs` (`SERVER_INFO`);
- dòng `version:` của `skills/gdrive/SKILL.md` và `skills/gdrive-setup/SKILL.md`.

Run: `node --test test/version.test.mjs`
Expected: PASS.

- [ ] **Step 3: CHANGELOG**

Thêm mục `## [0.5.0] - <ngày làm>` ngay dưới `## [Chưa phát hành]`:

```markdown
## [0.5.0] - YYYY-MM-DD

### Thay đổi phá tương thích

- Bỏ danh sách folder. Quyền lấy theo share trên Drive: service account là Editor thì đọc và
  ghi, Viewer thì chỉ đọc, không được share thì không thấy. Khoá `folders` và biến
  `GDRIVE_FOLDERS` bị bỏ qua.
- Bỏ lệnh `gdrive folder`.
- `gdrive init` mặc định `--mode readwrite`. Config cũ đang `readonly` giữ nguyên; bật ghi bằng
  `gdrive init --mode readwrite --yes`.

### Thêm

- `drive_ls` không tham số liệt kê Shared Drive và mọi thứ được share cho service account, kèm
  nhãn `read`/`write`. `gdrive ls` không đích làm tương tự.
- Địa chỉ `tên-mục-được-share/đường/dẫn` trong mọi tool.
- `gdrive status` đếm số mục được share và số mục ghi được.

### Đổi

- Tool ghi kiểm `capabilities.canEdit`/`canAddChildren` trước khi gọi API, báo lỗi "Chỉ đọc"
  thay cho 403 thô.
- Đọc file theo id không còn lần theo folder cha, nên bớt 1 đến vài request mỗi file mới.
- `gdrive ls --query` dùng lại được.
```

Thay `YYYY-MM-DD` bằng ngày thật lúc commit. Cập nhật link cuối file:

```markdown
[Chưa phát hành]: https://github.com/sdc-ren/gdrive-cli/compare/v0.5.0...develop
[0.5.0]: https://github.com/sdc-ren/gdrive-cli/compare/v0.4.0...v0.5.0
```

- [ ] **Step 4: README, SKILL, SECURITY, CONTRIBUTING**

Tìm mọi chỗ cần sửa:

```bash
grep -n "folder add\|folder list\|folder set\|folder remove\|GDRIVE_FOLDERS\|\"folders\"\|alias\|folder được phép\|ngoài phạm vi" README.md skills/*/SKILL.md SECURITY.md CONTRIBUTING.md
```

README:
- Xoá phần khai báo folder, ví dụ config có `folders`, đoạn `GDRIVE_FOLDERS` cho CI, và mục `gdrive folder`.
- Luồng cài còn 2 bước: cài, rồi `gdrive init --sa-json <file>`. Sau đó share folder cho email service account.
- Thêm mục "Quyền" với bảng:

  | Share cho email service account | AI làm được |
  |---|---|
  | Editor | đọc, ghi ô, append, tạo, đổi tên, di chuyển |
  | Viewer / Commenter | chỉ đọc |
  | Không share | không thấy |
  | `mode: readonly` trong config | chỉ đọc mọi nơi, tool ghi bị ẩn |

- Thêm cảnh báo: AI ghi được mọi thứ service account là Editor. Share Viewer cho những gì chỉ cần đọc. Email service account nên coi là tài khoản riêng của AI.
- Thêm mục "Nâng cấp từ v0.4.0": khoá `folders` không còn tác dụng, xoá thì tuỳ; muốn ghi thì `gdrive init --mode readwrite --yes`; lệnh `gdrive folder` đã bỏ.
- Ví dụ địa chỉ `alias/path` đổi thành `tên-mục-được-share/path`, ví dụ `gdriver/bao-cao/KPI`.
- Ví dụ output `drive_ls` đổi sang dạng `# 5 shared` như spec mục 2.

`skills/gdrive/SKILL.md`: thay hướng dẫn `folder add` và alias bằng: gọi `drive_ls` để xem gì được share; 404/403 thì nhờ người dùng share cho email service account; "Chỉ đọc" thì cần quyền Editor.

`skills/gdrive-setup/SKILL.md`: bỏ bước `folder add`; thêm bước "share folder cho email service account, Editor nếu muốn AI ghi".

`SECURITY.md`, mục "Những thứ được tính là lỗ hổng": thay gạch đầu dòng "Phạm vi folder bị vượt qua…" bằng:

```markdown
- Ghi được khi config đang `mode: readonly`.
- Tool đọc hoặc ghi được file không share cho service account.
```

Ở mục "Ngoài phạm vi", thay "tự thêm folder với `--access write`" bằng "tự share quyền Editor". Bảng phiên bản: `0.5.x | Có`, `< 0.5 | Không`.

`CONTRIBUTING.md`:
- Thay đoạn "Mọi truy cập đi qua danh sách folder…" bằng:

```markdown
Quyền do Drive quyết định qua share (`src/access.mjs`): Editor thì ghi, Viewer thì đọc. Tool ghi
kiểm `capabilities` trước khi gọi API và bị ẩn khi config `mode: readonly`.
```

- Bảng cấu trúc: dòng `src/folders.mjs, src/scope.mjs` thay bằng `src/access.mjs` với mô tả "Mục được share, phân giải địa chỉ, kiểm quyền ghi".
- Ví dụ `git tag -a v0.4.0` đổi thành `v0.5.0`.

Theo ghi chú của người dùng từ các đợt trước, chạy skill `humanizer:humanizer` trên các đoạn README mới viết.

- [ ] **Step 5: Kiểm và commit**

Run: `node --test && node bench/tokens.mjs`
Expected: PASS.

Chạy lại lệnh `grep` ở Step 4. Chỉ được còn kết quả trong mục "Nâng cấp từ v0.4.0" của README và trong CHANGELOG.

```bash
git add README.md CHANGELOG.md SECURITY.md CONTRIBUTING.md skills package.json .claude-plugin/plugin.json server/index.mjs test/version.test.mjs
git commit -m "docs: v0.5.0 — quyền theo share, hướng dẫn nâng cấp; bump 0.5.0

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Kiểm chứng trên Drive thật và đo token

**Files:**
- Modify: `docs/superpowers/specs/2026-10-02-share-based-access-design.md` (thêm mục "Kết quả kiểm chứng")
- Modify: `README.md` (số token của `drive_ls` gốc, nếu README có bảng số)

Cần config thật trên máy. Config hiện có nằm ở `~/.claude/plugins/data/gdrive-gdrive-cli/config.json`, `mode: readonly`. Chỉ ghi khi người dùng đồng ý đổi mode cho lần chạy, bằng `--mode readwrite` trên CLI hoặc biến môi trường cho server thử. **Không** sửa config thật của người dùng nếu chưa hỏi.

- [ ] **Step 1: Đọc (không cần quyền ghi)**

```bash
node bin/cli.mjs ls
node bin/cli.mjs ls --json | head -c 600
```

Expected: `# 5 shared · readonly — …` với 5 folder đo hôm 2026-10-02, tất cả `(read)` vì config đang readonly.

Kiểm qua MCP server bằng một script tạm trong scratchpad. Script gửi `initialize`, `tools/list`, rồi `tools/call drive_ls {}` và `drive_read { target: 'gdriver' }` vào `node server/index.mjs`, sau đó in các frame.

Expected:
- `tools/list` có 2 tool;
- `drive_ls` có 5 dòng `d … (read) …`;
- `drive_read gdriver` trả `# gdriver · folder · dùng drive_ls để liệt kê`, tức là phân giải được tên gốc `gdriver`, chỉ 7 ký tự.

- [ ] **Step 2: Ghi (hỏi người dùng trước)**

Hỏi người dùng hai điều: cho chạy thử ghi trong folder `gdriver` không, và có Google Sheet trống nào để ghi không. Nếu đồng ý thì chạy với `GDRIVE_CONFIG_DIR` trỏ tới bản sao config trong scratchpad đã đổi `mode: readwrite`, để không đụng file thật:

- `drive_create { parent: 'gdriver', name: 'gdrive-v05-verify', kind: 'folder' }` → `✓ folder …`
- `drive_move { target: 'gdriver/gdrive-v05-verify', new_name: 'gdrive-v05-verified' }` → `✓ gdrive-v05-verified`
- Nếu có Sheet thử: `sheet_write { target: <url>, cells: { A1: 'v0.5' }, append: [['ok']] }` → `✓ …: 1 cells, +1 rows`
- Nếu người dùng share được một folder quyền Viewer: `drive_create` vào đó → `✗ Chỉ đọc: …`

Xoá bản sao config trong scratchpad sau khi xong.

- [ ] **Step 3: Đo token**

Đo output `drive_ls` gốc bằng tiktoken `o200k_base`, cùng cách đo ở `docs/superpowers/specs/2026-10-01-measurements.md`. Ghi bảng vào spec mục mới "Kết quả kiểm chứng (ngày đo)":
- token schema ở `readwrite` và `readonly`;
- token `drive_ls` gốc;
- độ trễ `drive_ls` gốc lần đầu và lần hai (lần hai phải từ cache, dưới 50 ms);
- số request khi đọc một sheet theo id, so với v0.4.0.

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
    - capabilities → Task 1 và 2;
    - `mode` → Task 2, 5, 6;
    - `folders` và `GDRIVE_FOLDERS` bị bỏ qua → Task 5, 6;
    - lệnh `folder` → Task 6.
  - Mục 2:
    - gốc, cache, phân trang, readonly, danh sách rỗng → Task 2, 3, 4;
    - phân giải địa chỉ → Task 2;
    - tool ghi theo mode → Task 4, 5;
    - instructions → Task 5;
    - My Drive giữ nguyên quy tắc cũ → Task 4 (test `drive_create` cũ giữ nguyên).
  - Mục 3 CLI → Task 6. Mục 4 bảng file → Task 1–6. Mục 5 test → các task tương ứng, phần kiểm chứng thật → Task 8. Mục 6 tài liệu → Task 7.
- **Tên nhất quán:**
  - `createAccess`, `access.roots/resolve/accessOf/assertCanEdit/assertCanAddChildren/invalidate`, `modeFromConfig`, `AccessError`, `MIME_SHARED_DRIVE`, `READONLY_HINT`, `renderRoots`, `listSharedWithMe`, `listDrives` dùng giống nhau ở Task 1–6.
  - `buildTools({ getClient, mode })` dùng ở Task 4, 5, 6.
- **Review Focus:**
  - (1) và (2): `test/access.test.mjs`.
  - (3): Task 1 test `FILE_FIELDS`, cộng test `sheet_write qua đường dẫn` ở Task 4.
  - (4): Task 5 test config v0.4.0, Task 6 test status.
  - (5): Task 4 test shortcut.
