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

export const MODES = ['readonly', 'readwrite'];

/**
 * Không có config: readonly (chưa có credential). Có config mà thiếu `mode`: readwrite.
 * Giá trị lạ (gõ sai, sai hoa thường) là readonly: đây là khoá an toàn, sai thì phải đóng.
 */
export function modeFromConfig(cfg) {
  if (!cfg) return 'readonly';
  if (cfg.mode === undefined) return 'readwrite';
  return cfg.mode === 'readwrite' ? 'readwrite' : 'readonly';
}

export function createAccess({ meta, mode = 'readwrite' }) {
  const writable = (flag) => mode === 'readwrite' && flag === true;

  function deny(flag, m) {
    if (mode !== 'readwrite') throw new AccessError('READ_ONLY', `Đang ở chế độ readonly, không ghi. ${READONLY_HINT}`);
    if (flag !== true) throw new AccessError('READ_ONLY', `Chỉ đọc: service account chưa có quyền Editor với "${m?.name ?? '?'}".`);
  }

  // Quyền nằm trong metadata cache 5 phút: người dùng vừa nâng Viewer lên Editor thì lần đầu bị
  // từ chối oan. Bị từ chối thì lấy lại metadata đúng một lần rồi xét lại, nên chỉ tốn thêm
  // request khi bị từ chối.
  async function ensure(flagOf, m) {
    try {
      deny(flagOf(m), m);
      return m;
    } catch (err) {
      if (mode !== 'readwrite' || !m?.id) throw err;
      meta.invalidate(m.id);
      const fresh = await meta.file(m.id);
      deny(flagOf(fresh), fresh);
      return fresh;
    }
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
    /** Như assert*, nhưng bị từ chối thì đọc lại metadata một lần. Trả metadata đã xét. */
    ensureCanEdit: (m) => ensure((x) => x?.capabilities?.canEdit, m),
    ensureCanAddChildren: (m) => ensure((x) => x?.capabilities?.canAddChildren, m),
  };
}
