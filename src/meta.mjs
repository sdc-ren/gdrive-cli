// Metadata Drive/Sheets đi qua cache 5 phút. Mọi tool lấy metadata ở đây, không gọi
// getFile/getMetadata trực tiếp — nhờ vậy đọc lặp lại một sheet chỉ còn 1 request.

import { createTtlCache } from './cache.mjs';
import { getFile, listFiles } from './drive.mjs';
import { getMetadata } from './sheets.mjs';

export const META_FIELDS = 'id,name,mimeType,size,parents,driveId,modifiedTime,webViewLink,shortcutDetails';
const TTL_MS = 5 * 60_000;

export function createMetaStore({ client, now = Date.now, ttlMs = TTL_MS } = {}) {
  const files = createTtlCache({ ttlMs, now });
  const sheets = createTtlCache({ ttlMs, now });
  return {
    file: (id) => files.getOrLoad(id, () => getFile(client, id, { fields: META_FIELDS })),
    sheet: (id) => sheets.getOrLoad(id, () => getMetadata(client, id)),
    /** Con trực tiếp tên đúng `name` (so khớp chính xác phía client, Drive chỉ có `contains`). */
    async findChild(parentId, name) {
      const { files: found } = await listFiles(client, { folderId: parentId, nameContains: name, max: 100 });
      const exact = found.find((f) => f.name === name);
      if (!exact) return null;
      files.set(exact.id, exact);
      return exact;
    },
    invalidate(id) {
      files.delete(id);
      sheets.delete(id);
    },
    clear() {
      files.clear();
      sheets.clear();
    },
  };
}
