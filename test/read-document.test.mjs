import assert from 'node:assert/strict';
import { test } from 'node:test';

import { MAX_DOWNLOAD_BYTES, readDocument, readTable } from '../src/read-document.mjs';
import { makeZip } from './helpers/make-zip.mjs';

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

const xlsx = () => makeZip([
  { name: 'xl/workbook.xml', data: `<workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="T" sheetId="1" r:id="rId1"/></sheets></workbook>` },
  { name: 'xl/_rels/workbook.xml.rels', data: `<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>` },
  { name: 'xl/worksheets/sheet1.xml', data: `<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>ID</t></is></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>TC1</t></is></c></row></sheetData></worksheet>` },
]);
const docx = (text) => makeZip([
  { name: 'word/document.xml', data: `<w:document xmlns:w="w"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>` },
]);

function fakeClient({ meta, bytes }) {
  const calls = [];
  return {
    calls,
    async api(opts) {
      calls.push(opts.url);
      if (/alt=media|\/export\?/.test(opts.url)) return bytes;
      return meta;
    },
  };
}

test('readTable với meta có sẵn: KHÔNG gọi files.get, chỉ tải nội dung', async () => {
  const meta = { id: 'x', name: 'a.xlsx', mimeType: XLSX_MIME, size: '1000' };
  const client = fakeClient({ meta, bytes: xlsx() });
  const res = await readTable(client, 'x', { meta });
  assert.deepEqual(res.rows, [['ID'], ['TC1']]);
  assert.equal(client.calls.length, 1);
  assert.match(client.calls[0], /alt=media/);
});

test('readDocument với meta có sẵn: 1 request; max_chars cắt đúng và báo truncated', async () => {
  const meta = { id: 'd', name: 'g.docx', mimeType: DOCX_MIME, size: '10' };
  const client = fakeClient({ meta, bytes: docx('một hai ba bốn') });
  const res = await readDocument(client, 'd', { meta, maxChars: 7 });
  assert.equal(client.calls.length, 1);
  assert.equal(res.content, 'một hai');
  assert.equal(res.truncated, true);
  assert.equal(res.charCount, 14);
});

test('file lớn hơn MAX_DOWNLOAD_BYTES bị từ chối TRƯỚC khi tải', async () => {
  const meta = { id: 'big', name: 'big.xlsx', mimeType: XLSX_MIME, size: String(MAX_DOWNLOAD_BYTES + 1) };
  const client = fakeClient({ meta, bytes: xlsx() });
  await assert.rejects(readTable(client, 'big', { meta }), (e) => e.code === 'TOO_LARGE' && /gdrive get/.test(e.message));
  assert.equal(client.calls.length, 0);
});

test('không truyền meta thì readTable tự inspect như cũ (tương thích thư viện)', async () => {
  const meta = { id: 'x', name: 'a.xlsx', mimeType: XLSX_MIME };
  const client = fakeClient({ meta, bytes: xlsx() });
  const res = await readTable(client, 'x');
  assert.equal(res.rows.length, 2);
  assert.equal(client.calls.length, 2);
});
