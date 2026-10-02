import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildTools } from '../src/tools.mjs';
import { makeZip } from './helpers/make-zip.mjs';

const FOLDER = 'application/vnd.google-apps.folder';
const GSHEET = 'application/vnd.google-apps.spreadsheet';
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

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
const VALUES = [['ID', 'Trạng thái', 'Ghi chú'], ['TC1', 'PASS', 'ok'], ['TC2', 'FAIL', 'lỗi'], ['TC3', 'FAIL', '']];
const xlsxBuf = () => makeZip([
  { name: 'xl/workbook.xml', data: `<workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Data" sheetId="1" r:id="rId1"/></sheets></workbook>` },
  { name: 'xl/_rels/workbook.xml.rels', data: `<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>` },
  { name: 'xl/worksheets/sheet1.xml', data: `<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>k</t></is></c></row><row r="2"><c r="A2"><v>42</v></c></row></sheetData></worksheet>` },
]);

// `extra`: file bổ sung cho riêng một test. `onGet(id, n, file)`: đổi kết quả lần GET thứ n
// của file `id` (mô phỏng metadata trên Drive đã đổi so với cache).
function fakeClient({ extra = {}, onGet = null } = {}) {
  const calls = [];
  const all = { ...FILES, ...extra };
  const gets = new Map();
  const client = {
    calls,
    gets,
    identity: { clientEmail: 'sa@p.iam.gserviceaccount.com' },
    async api(opts) {
      calls.push(opts);
      const u = opts.url;
      let m;
      if ((m = /drive\/v3\/files\/([^/?]+)\?.*alt=media/.exec(u))) return xlsxBuf();
      if ((m = /drive\/v3\/files\/([^/?]+)\?/.exec(u)) && opts.method === 'PATCH') return { id: m[1], ...opts.body };
      if ((m = /drive\/v3\/files\/([^/?]+)\?/.exec(u))) {
        if (!all[m[1]]) { const e = new Error('not found'); e.code = 404; throw e; }
        const n = (gets.get(m[1]) ?? 0) + 1;
        gets.set(m[1], n);
        return onGet ? onGet(m[1], n, all[m[1]]) : all[m[1]];
      }
      // upload và POST tạo folder phải đứng trước nhánh list: URL của chúng cũng khớp `files?`.
      if (/upload\/drive\/v3\/files/.test(u)) return { id: 'new1aaaa', name: 'new', webViewLink: 'https://drive.google.com/x' };
      if (/drive\/v3\/files$/.test(u.split('?')[0]) && opts.method === 'POST') return { id: 'newFolder1', name: opts.body.name };
      if (/drive\/v3\/files\?/.test(u)) {
        // URLSearchParams mã hoá khoảng trắng thành '+'.
        const folder = /'([^']+)' in parents/.exec(decodeURIComponent(u.replace(/\+/g, ' ')))?.[1];
        return { files: Object.values(all).filter((f) => (f.parents ?? []).includes(folder)), nextPageToken: null };
      }
      if (/spreadsheets\/[^/]+\?fields/.test(u)) return { properties: { title: 'TC_login' }, sheets: [{ properties: { sheetId: 0, title: 'Sheet1', index: 0 } }, { properties: { sheetId: 9, title: 'Data', index: 1 } }] };
      if (/values:batchUpdate/.test(u)) return { totalUpdatedCells: opts.body.data.length, responses: [] };
      if (/:append/.test(u)) return { updates: { updatedRange: "'Sheet1'!A5:C5", updatedCells: opts.body.values.flat().length } };
      if (/\/values\//.test(u)) return { values: VALUES };
      throw new Error(`fake: không biết ${opts.method ?? 'GET'} ${u}`);
    },
  };
  return client;
}

const tools = (mode = 'readwrite', client = fakeClient()) => {
  const list = buildTools({ getClient: () => client, mode });
  return { client, byName: new Map(list.map((t) => [t.name, t])), names: list.map((t) => t.name) };
};

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

test('drive_read Google Sheet: TSV, lọc where, chọn cột, header # có tabs và next', async () => {
  const { byName, client } = tools();
  const out = await byName.get('drive_read').run({ target: 'https://docs.google.com/spreadsheets/d/sheet1aaaa/edit', where: { 'Trạng thái': 'FAIL' }, columns: ['ID'], limit: 1 });
  assert.deepEqual(out.split('\n'), ['# TC_login › Sheet1 · tabs: Sheet1,Data · rows 1-1/2 · next=1', 'ID', 'TC2']);
  const valueCalls = client.calls.filter((c) => /\/values\//.test(c.url));
  assert.equal(valueCalls.length, 1, 'lọc phía server, chỉ 1 request lấy giá trị');
});

test('drive_read lần hai cùng file: metadata lấy từ cache, chỉ còn 1 request', async () => {
  const { byName, client } = tools();
  await byName.get('drive_read').run({ target: 'sheet1aaaa' });
  const before = client.calls.length;
  await byName.get('drive_read').run({ target: 'sheet1aaaa' });
  assert.equal(client.calls.length - before, 1);
});

test('drive_read xlsx bằng id; link không share → lỗi 404 nguyên vẹn', async () => {
  const { byName } = tools();
  const out = await byName.get('drive_read').run({ target: 'book1aaaa' });
  assert.equal(out.split('\n')[0], '# report.xlsx › Data · tabs: Data · rows 1-1/1');
  assert.equal(out.split('\n')[2], '42');
  await assert.rejects(byName.get('drive_read').run({ target: 'khongShare1' }), (e) => e.code === 404);
});

test('drive_read folder → dòng metadata gợi ý drive_ls', async () => {
  const { byName } = tools();
  assert.match(await byName.get('drive_read').run({ target: 'rootAaaaa' }), /^# Test Run · folder · dùng drive_ls/);
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

test('drive_create: folder/doc/sheet trong folder write, TSV → CSV; folder read bị từ chối', async () => {
  const { byName, client } = tools();
  assert.match(await byName.get('drive_create').run({ parent: 'rootAaaaa', name: 'Q4', kind: 'folder' }), /^✓ folder Q4 newFolder1/);
  assert.match(await byName.get('drive_create').run({ parent: 'rootAaaaa', name: 'Ghi chú', kind: 'doc', content: '# x' }), /^✓ doc Ghi chú new1aaaa https:/);
  await byName.get('drive_create').run({ parent: 'rootAaaaa', name: 'S', kind: 'sheet', content: 'a\tb\n1\t2' });
  const upload = client.calls.filter((c) => /upload\//.test(c.url)).at(-1);
  assert.match(upload.body.toString('utf8'), /"mimeType":"application\/vnd\.google-apps\.spreadsheet"/);
  assert.match(upload.body.toString('utf8'), /a,b\r?\n1,2/);
  await assert.rejects(byName.get('drive_create').run({ parent: 'rootBaaaa', name: 'x', kind: 'folder' }), (e) => e.code === 'READ_ONLY');
  // Đo thật 2026-10-01: My Drive tạo folder được, tạo Doc/Sheet bị storageQuotaExceeded → chặn trước khi gọi API.
  assert.match(await byName.get('drive_create').run({ parent: 'rootCaaaa', name: 'Q5', kind: 'folder' }), /^✓ folder Q5/);
  const callsBefore = client.calls.length;
  await assert.rejects(byName.get('drive_create').run({ parent: 'rootCaaaa', name: 'd', kind: 'doc', content: 'x' }), /Shared Drive/);
  assert.equal(client.calls.filter((c) => /upload\//.test(c.url)).length, client.calls.slice(0, callsBefore).filter((c) => /upload\//.test(c.url)).length, 'không gọi upload khi biết trước sẽ thất bại');
  await assert.rejects(byName.get('drive_create').run({ parent: 'rootAaaaa', name: 'x', kind: 'pdf' }), /kind/);
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

test('không tool nào có tham số đường dẫn trên máy', () => {
  const schemas = JSON.stringify(buildTools({ getClient: () => null, mode: 'readwrite' }).map((t) => t.inputSchema));
  assert.doesNotMatch(schemas, /dest_path|local_path/);
});

const SUB = { subAaaaaa: { id: 'subAaaaaa', name: 'Sub', mimeType: FOLDER, parents: ['rootAaaaa'], capabilities: RW } };

test('drive_move: chuyển từ folder gốc sang folder con → addParents=con, removeParents=gốc', async () => {
  const { byName, client } = tools('readwrite', fakeClient({ extra: SUB }));
  const out = await byName.get('drive_move').run({ target: 'sheet1aaaa', to: 'subAaaaaa' });
  assert.match(out, /^✓ TC_login → Sub/);
  const patch = client.calls.find((c) => c.method === 'PATCH');
  assert.match(patch.url, /addParents=subAaaaaa/);
  assert.match(patch.url, /removeParents=rootAaaaa(&|$)/);
});

test('drive_move: parents lấy lại thấy rỗng → từ chối, không PATCH', async () => {
  const onGet = (id, n, f) => (id === 'sheet1aaaa' && n > 1 ? { ...f, parents: undefined } : f);
  const { byName, client } = tools('readwrite', fakeClient({ extra: SUB, onGet }));
  await assert.rejects(byName.get('drive_move').run({ target: 'sheet1aaaa', to: 'subAaaaaa' }), /Không xác định/);
  assert.equal(client.calls.some((c) => c.method === 'PATCH'), false);
});

test('sheet_write: chặn công thức IMPORT*/IMAGE trước mọi lời gọi API; công thức thường vẫn ghi', async () => {
  const { byName, client } = tools();
  await assert.rejects(byName.get('sheet_write').run({ target: 'sheet1aaaa', cells: { A1: '=IMPORTRANGE("x","A1")' } }), /IMPORT\*\/IMAGE/);
  await assert.rejects(byName.get('sheet_write').run({ target: 'sheet1aaaa', append: [['ok', '=image("http://x")']] }), /IMPORT\*\/IMAGE/);
  assert.equal(client.calls.length, 0, 'không gọi API nào');
  assert.equal(await byName.get('sheet_write').run({ target: 'sheet1aaaa', cells: { A4: '=SUM(A1:A3)' } }), '✓ Sheet1: 1 cells, +0 rows');
  const batch = client.calls.find((c) => /batchUpdate/.test(c.url));
  assert.equal(batch.body.valueInputOption ?? 'USER_ENTERED', 'USER_ENTERED');
});

test('drive_create sheet: nội dung có IMPORTDATA bị chặn trước khi upload', async () => {
  const { byName, client } = tools();
  await assert.rejects(byName.get('drive_create').run({ parent: 'rootAaaaa', name: 'S', kind: 'sheet', content: 'a,b\n1,=IMPORTDATA("http://x")' }), /IMPORT\*\/IMAGE/);
  await assert.rejects(byName.get('drive_create').run({ parent: 'rootAaaaa', name: 'S', kind: 'sheet', content: 'a\tb\n1\t=IMPORTDATA("http://x")' }), /IMPORT\*\/IMAGE/);
  assert.equal(client.calls.filter((c) => /upload\//.test(c.url)).length, 0);
  assert.equal(client.calls.length, 0, 'chặn trước cả lúc resolve parent');
});

test('shortcut trong folder ghi được trỏ tới file Viewer: sheet_write và drive_move đều READ_ONLY', async () => {
  const extra = { shortRWaa: { id: 'shortRWaa', name: 'KPI link', mimeType: 'application/vnd.google-apps.shortcut', parents: ['rootAaaaa'], shortcutDetails: { targetId: 'sheetBaaaa' }, capabilities: RW } };
  const { byName, client } = tools('readwrite', fakeClient({ extra }));
  await assert.rejects(byName.get('sheet_write').run({ target: 'shortRWaa', cells: { A1: 'x' } }), (e) => e.code === 'READ_ONLY');
  await assert.rejects(byName.get('drive_move').run({ target: 'shortRWaa', new_name: 'y' }), (e) => e.code === 'READ_ONLY');
  await assert.rejects(byName.get('drive_move').run({ target: 'shortRWaa', to: 'rootAaaaa' }), (e) => e.code === 'READ_ONLY');
  assert.equal(client.calls.some((c) => c.method === 'PATCH' || /batchUpdate|:append/.test(c.url)), false);
});

test('drive_create: name rỗng/chỉ khoảng trắng bị từ chối trước mọi lời gọi API', async () => {
  const { byName, client } = tools();
  await assert.rejects(byName.get('drive_create').run({ parent: 'rootAaaaa', name: '   ', kind: 'folder' }), /name không được rỗng/);
  await assert.rejects(byName.get('drive_create').run({ parent: 'rootAaaaa', name: '', kind: 'doc' }), /name không được rỗng/);
  assert.equal(client.calls.length, 0);
});
