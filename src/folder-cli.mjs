// `gdrive folder …`: quản lý danh sách folder được phép trong file config.
//
// `add` gọi Drive một lần để chắc service account thấy folder và đó đúng là folder; sai thì
// báo ngay thay vì để tool báo 404 mơ hồ về sau. Không bao giờ sửa phần credential.

import { homedir } from 'node:os';

import { createClient } from './client.mjs';
import { readConfigWithSource, writeConfig } from './config.mjs';
import { getFile } from './drive.mjs';
import { MIME } from './formats.mjs';
import { ACCESS_LEVELS, addFolder, loadFolders, removeFolder, setAccess, slugify } from './folders.mjs';
import { parseGoogleUrl } from './url.mjs';

const USAGE = `Cách dùng:
  gdrive folder add <url|id> [--name <tên>] [--access read|write]   (mặc định read)
  gdrive folder list
  gdrive folder set <tên> --access read|write
  gdrive folder remove <tên>`;

function defaultGetFile(home, env) {
  const client = createClient({ mode: 'readonly', retries: 2, env, ...(home ? { home } : {}) });
  return (id) => getFile(client, id, { fields: 'id,name,mimeType,driveId' });
}

export async function runFolder(flags = { _: [] }, { home = homedir(), env = process.env, log = console.log, getFile: fetchFile = null } = {}) {
  const sub = flags._[1];
  const arg = flags._[2];
  const found = readConfigWithSource(home, env);
  const config = found?.config ?? {};
  const folders = loadFolders({ config, env });

  if (sub === 'list') {
    if (!folders.length) {
      log('Chưa có folder nào được phép. Thêm bằng: gdrive folder add <url-folder> [--access write]');
      return true;
    }
    const w = Math.max(...folders.map((f) => f.name.length));
    for (const f of folders) log(`${f.name.padEnd(w)}  ${f.access.padEnd(5)}  ${f.id}`);
    if (env.GDRIVE_FOLDERS) log('\n(đang lấy từ biến GDRIVE_FOLDERS, không phải file config)');
    return true;
  }

  if (!['add', 'set', 'remove'].includes(sub)) {
    log(USAGE);
    return false;
  }
  if (env.GDRIVE_FOLDERS) {
    log('❌ Biến GDRIVE_FOLDERS đang được đặt nên danh sách lấy từ env; sửa file config sẽ không có tác dụng. Bỏ biến đó rồi chạy lại.');
    return false;
  }
  if (!found) {
    log('❌ Chưa có cấu hình. Chạy trước: gdrive init --sa-json <đường-dẫn-key.json>');
    return false;
  }

  let next;
  try {
    if (sub === 'add') {
      if (!arg) throw new Error(`Thiếu URL hoặc id folder.\n${USAGE}`);
      const access = flags.access ?? 'read';
      if (!ACCESS_LEVELS.includes(access)) throw new Error('--access phải là read hoặc write.');
      const { id } = parseGoogleUrl(String(arg));
      let meta;
      try {
        meta = await (fetchFile ?? defaultGetFile(home, env))(id);
      } catch (err) {
        if (Number(err?.code) === 404 || Number(err?.code) === 403) {
          throw new Error(`Service account không thấy folder ${id} — chưa share cho ${config.clientEmail ?? 'service account'} (Viewer để đọc, Editor để ghi).`);
        }
        throw err;
      }
      if (meta.mimeType !== MIME.FOLDER) throw new Error(`"${meta.name}" không phải folder (${meta.mimeType}).`);
      const name = flags.name ? String(flags.name) : slugify(meta.name);
      next = addFolder(folders, { id: meta.id, name, access });
      log(`✅ Đã thêm ${name} (${access}) ← "${meta.name}"${meta.driveId ? '' : '\n   Folder nằm trên My Drive: tạo file mới trong đó sẽ thất bại vì service account không có dung lượng; ghi ô Sheet vẫn được.'}`);
    } else if (sub === 'set') {
      if (!arg || !flags.access) throw new Error(`Cần <tên> và --access.\n${USAGE}`);
      if (!ACCESS_LEVELS.includes(flags.access)) throw new Error('--access phải là read hoặc write.');
      next = setAccess(folders, String(arg), flags.access);
      log(`✅ ${arg} → ${flags.access}`);
    } else {
      if (!arg) throw new Error(`Thiếu <tên>.\n${USAGE}`);
      next = removeFolder(folders, String(arg));
      log(`✅ Đã bỏ ${arg} khỏi danh sách (file trên Drive không bị đụng tới).`);
    }
  } catch (err) {
    log(`❌ ${err.message}`);
    return false;
  }

  const { mode, ...rest } = config; // khoá mode cũ không còn ý nghĩa khi có folders
  writeConfig({ ...rest, folders: next }, home, env);
  log('MCP server nhận thay đổi ở request kế tiếp; client không refresh tool list thì mở session mới.');
  return true;
}
