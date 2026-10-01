// Phạm vi folder cho các lệnh CLI (read/doc/ls/write/put) — tách khỏi bin/cli.mjs để test
// được mà không chạy CLI hay gọi mạng.
//
// Khi đã có danh sách folder, CLI tuân phạm vi như MCP: file ngoài folder được phép bị từ
// chối, ghi vào folder chỉ có quyền read cũng bị từ chối. Chưa có danh sách thì CLI dùng mọi
// thứ service account thấy (dùng tay, không phải model gọi) và khoá `mode` cũ vẫn quyết định.

import { createMetaStore } from './meta.mjs';
import { createScope } from './scope.mjs';
import { parseGoogleUrl } from './url.mjs';

function modeError(message) {
  const e = new Error(message);
  e.exitCode = 3;
  return e;
}

/**
 * Chế độ client cho một lệnh. Có folders thì khoá `mode` trong config bị bỏ qua: suy từ
 * access (có folder write → readwrite); quyền ghi từng file do resolveCliTarget kiểm.
 */
export function resolveCliMode({ flags = {}, cfg = null, folders = [], needWrite = false }) {
  if (folders.length > 0) {
    const anyWrite = folders.some((f) => f.access === 'write');
    if (needWrite && !anyWrite) {
      throw modeError('Không folder nào có quyền write. Bật: gdrive folder set <tên> --access write');
    }
    return flags.mode ?? (anyWrite ? 'readwrite' : 'readonly');
  }
  const mode = flags.mode ?? cfg?.mode ?? 'readonly';
  if (needWrite && mode !== 'readwrite') {
    throw modeError(
      'Đang ở chế độ readonly nên lệnh này bị từ chối.\n' +
        'Bật ghi: gdrive init --mode readwrite   (hoặc thêm --mode readwrite cho lần chạy này)',
    );
  }
  return mode;
}

/**
 * `input` (URL, id, hoặc `tên/đường/dẫn`) → `{ id, gid }`. Mỗi lần gọi tạo scope mới (scope
 * bất biến theo danh sách folder). `write: true` thì file phải nằm trong folder có quyền write.
 * `createMeta` inject được để test.
 */
export async function resolveCliTarget({ client, input, write = false, folders = [], createMeta = createMetaStore }) {
  if (!folders.length) {
    const { id, gid } = parseGoogleUrl(input);
    return { id, gid };
  }
  const scope = createScope({ folders, meta: createMeta({ client }) });
  const { fileId, gid } = await scope.resolve(input);
  if (write) await scope.assertWrite(fileId);
  return { id: fileId, gid };
}

/**
 * Đích cho `gdrive ls`. Có folders mà không target → `{ roots: folders }` (in danh sách folder
 * được phép, không gọi Drive — nếu không, ls trần sẽ liệt kê mọi thứ service account thấy).
 * Còn lại → `{ folderId }` (null = mọi thứ, chỉ khi chưa có danh sách folder).
 */
export async function resolveCliListTarget({ client, target, folders = [], createMeta = createMetaStore }) {
  if (!target) return folders.length ? { roots: folders } : { folderId: null };
  const { id } = await resolveCliTarget({ client, input: target, folders, createMeta });
  return { folderId: id };
}

/**
 * `gdrive ls --query` nối mệnh đề `q` thô vào sau `'<id>' in parents` bằng AND, nhưng
 * `... or ...` trong đó vẫn mở rộng ra ngoài folder. Có danh sách folder thì cấm hẳn.
 */
export function assertCliQueryAllowed({ query, folders = [] }) {
  if (!query || !folders.length) return;
  const e = new Error('--query không dùng được khi đã cấu hình folder (có thể thoát khỏi phạm vi).');
  e.exitCode = 2;
  throw e;
}
