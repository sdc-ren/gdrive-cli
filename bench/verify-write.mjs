// Thử từng thao tác ghi trên folder thật rồi in bảng. Chạy: node bench/verify-write.mjs <folder-url> [<folder-url-shared-drive>]
// Mọi thứ tạo ra đều nằm trong folder con "gdrive-verify-<timestamp>" để người dùng xoá một lần.
import { createClient } from '../src/client.mjs';
import { createFolder, getFile, uploadFile } from '../src/drive.mjs';
import { MIME } from '../src/formats.mjs';
import { appendValues, batchUpdateValues } from '../src/sheets.mjs';
import { parseGoogleUrl } from '../src/url.mjs';

const client = createClient({ mode: 'readwrite', retries: 2 });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');

async function attempt(label, fn) {
  try {
    const out = await fn();
    console.log(`OK    ${label}${out ? ` → ${out}` : ''}`);
    return out;
  } catch (e) {
    console.log(`FAIL  ${label} → ${e.code ?? ''} ${e.reason ?? ''} ${String(e.message).split('\n')[0]}`);
    return null;
  }
}

for (const url of process.argv.slice(2)) {
  const { id: parentId } = parseGoogleUrl(url);
  const parent = await getFile(client, parentId, { fields: 'id,name,driveId,capabilities(canAddChildren)' });
  console.log(`\n== ${parent.name} (${parent.driveId ? 'Shared Drive' : 'My Drive'}, canAddChildren=${parent.capabilities?.canAddChildren})`);

  const sub = await attempt('Tạo folder con', async () => (await createFolder(client, { name: `gdrive-verify-${stamp}`, parentId })).id);
  const target = sub ?? parentId;

  const doc = await attempt('Tạo Google Doc từ markdown', async () =>
    (await uploadFile(client, { name: 'verify-doc', folderId: target, content: '# Tiêu đề\n\nxin chào', mimeType: 'text/markdown', convertTo: MIME.GOOGLE_DOC })).id);
  const sheet = await attempt('Tạo Google Sheet từ CSV', async () =>
    (await uploadFile(client, { name: 'verify-sheet', folderId: target, content: 'ID,Trạng thái\nTC1,PASS\n', mimeType: 'text/csv', convertTo: MIME.GOOGLE_SHEET })).id);

  if (sheet) {
    await attempt('values.batchUpdate', () => batchUpdateValues(client, sheet, [{ range: "'Sheet1'!B2", values: [['FAIL']] }]));
    await attempt('values.append', () => appendValues(client, sheet, "'Sheet1'!A1", [['TC2', 'PASS']]));
  }
  if (doc) {
    await attempt('Đổi tên file', () => client.api({ url: `https://www.googleapis.com/drive/v3/files/${doc}?supportsAllDrives=true&fields=id,name`, method: 'PATCH', body: { name: 'verify-doc-renamed' } }));
    if (sub) {
      await attempt('Di chuyển file sang folder cha', () => client.api({ url: `https://www.googleapis.com/drive/v3/files/${doc}?supportsAllDrives=true&addParents=${parentId}&removeParents=${sub}&fields=id,parents`, method: 'PATCH', body: {} }));
    }
  }
  console.log(`Dọn: xoá folder "gdrive-verify-${stamp}" (và file verify-doc-renamed nếu đã di chuyển) trong ${parent.name}.`);
}
