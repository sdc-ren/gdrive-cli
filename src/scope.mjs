// Lớp phạm vi: một file chỉ được đọc/ghi khi nó, hoặc một tổ tiên theo `parents`, là
// folder trong danh sách. Kết quả lần theo tổ tiên cache 10 phút.
//
// Shortcut được coi là file ĐÍCH của nó: shortcut nằm trong folder được phép nhưng trỏ ra
// ngoài vẫn bị từ chối — nếu không, một shortcut do ai đó tạo là đủ để đọc file lạ.
//
// Một instance scope là BẤT BIẾN với danh sách folder truyền vào: `byId/byName` chụp lúc tạo,
// `invalidateAll()` chỉ xoá cache tổ tiên, không nạp lại danh sách. Đổi danh sách folder thì
// tạo scope mới: MCP server dựng lại tools/scope khi file config đổi (reload theo fingerprint),
// CLI tạo scope mới cho mỗi lệnh.

import { createTtlCache } from './cache.mjs';
import { FOLDER_NAME_RE } from './folders.mjs';
import { parseGoogleUrl } from './url.mjs';

const MIME_FOLDER = 'application/vnd.google-apps.folder';
const MIME_SHORTCUT = 'application/vnd.google-apps.shortcut';
const MAX_DEPTH = 32;
// Kết quả "bị cắt" (gặp vòng hoặc quá MAX_DEPTH): chưa xét đủ nên KHÔNG được cache là null.
const TRUNCATED = Symbol('truncated');
const TTL_MS = 10 * 60_000;

const isNotFound = (err) => err?.status === 404 || err?.code === 404;

export class ScopeError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ScopeError';
    this.code = code;
  }
}

export function createScope({ folders, meta, now = Date.now, ttlMs = TTL_MS }) {
  const byId = new Map(folders.map((f) => [f.id, f]));
  const byName = new Map(folders.map((f) => [f.name, f]));
  const roots = createTtlCache({ ttlMs, now }); // fileId → root folder | null
  const names = () => folders.map((f) => f.name).join(', ') || '(trống)';

  function requireFolders() {
    if (!folders.length) {
      throw new ScopeError('NO_FOLDERS', 'Chưa có folder nào được phép. Chạy: gdrive folder add <url-folder> [--access write]');
    }
  }

  /** Folder gốc chứa `id`, hoặc null. */
  async function rootOf(id) {
    const root = await walk(id, 0, new Set());
    return root === TRUNCATED ? null : root;
  }

  /**
   * Lần theo parents. Trả root | null | TRUNCATED. Chỉ cache kết quả đã xét đủ: root tìm thấy,
   * hoặc null khi MỌI parent đều xét xong mà không dẫn tới folder được phép. Nếu có nhánh bị
   * cắt thì không cache — tránh đánh dấu sai một node thật ra thuộc phạm vi qua đường khác.
   */
  async function walk(id, depth, seen) {
    if (byId.has(id)) return byId.get(id);
    const cached = roots.get(id);
    if (cached !== undefined) return cached;
    if (depth >= MAX_DEPTH || seen.has(id)) return TRUNCATED;
    seen.add(id);

    const m = await meta.file(id);
    let truncated = false;
    for (const parent of m.parents ?? []) {
      let r;
      try {
        r = await walk(parent, depth + 1, seen);
      } catch (err) {
        // Folder cha không truy cập được (404) chỉ có nghĩa nhánh đó không dẫn tới folder
        // được phép — vẫn xét các parent còn lại. Lỗi khác (mạng, 5xx) thì ném lên.
        if (!isNotFound(err)) throw err;
        r = null;
      }
      if (r === TRUNCATED) truncated = true;
      else if (r) {
        roots.set(id, r);
        return r;
      }
    }
    if (truncated) return TRUNCATED;
    roots.set(id, null);
    return null;
  }

  async function resolveTarget(id) {
    let m = await meta.file(id);
    if (m.mimeType === MIME_SHORTCUT) {
      const targetId = m.shortcutDetails?.targetId;
      if (!targetId) throw new ScopeError('OUT_OF_SCOPE', `Shortcut không có đích: "${m.name}" không trỏ tới file nào đọc được.`);
      m = await meta.file(targetId);
    }
    const root = await rootOf(m.id);
    if (!root) throw new ScopeError('OUT_OF_SCOPE', `Ngoài phạm vi: "${m.name}" không thuộc folder nào được phép (${names()}).`);
    return { fileId: m.id, root, meta: m };
  }

  async function resolvePath(input) {
    const [alias, ...rest] = input.split('/').filter(Boolean);
    let current = { id: byName.get(alias).id, name: alias, mimeType: MIME_FOLDER };
    let walked = alias;
    for (const segment of rest) {
      if (current.mimeType !== MIME_FOLDER) throw new ScopeError('NOT_FOUND', `"${walked}" không phải folder.`);
      const child = await meta.findChild(current.id, segment);
      if (!child) throw new ScopeError('NOT_FOUND', `Không có "${segment}" trong "${walked}".`);
      current = child;
      walked += `/${segment}`;
    }
    return { ...(await resolveTarget(current.id)), gid: null };
  }

  return {
    list: () => folders.slice(),
    hasWrite: () => folders.some((f) => f.access === 'write'),

    /** `input`: tên gợi nhớ, `tên/đường/dẫn`, URL Google hoặc id trần. */
    async resolve(input) {
      requireFolders();
      const raw = String(input ?? '').trim();
      const first = raw.split('/')[0];
      if (FOLDER_NAME_RE.test(first) && byName.has(first) && !raw.includes(':')) return resolvePath(raw);
      const { id, gid } = parseGoogleUrl(raw);
      return { ...(await resolveTarget(id)), gid };
    },

    /**
     * `fileId` phải là `fileId` do `resolve()` trả về: hàm này KHÔNG giải shortcut, truyền id
     * của shortcut sẽ xét quyền theo vị trí shortcut chứ không theo file đích.
     */
    async assertWrite(fileId) {
      requireFolders();
      const root = await rootOf(fileId);
      if (!root) throw new ScopeError('OUT_OF_SCOPE', `Ngoài phạm vi: file không thuộc folder nào được phép (${names()}).`);
      if (root.access !== 'write') throw new ScopeError('READ_ONLY', `Chỉ đọc: folder "${root.name}" có quyền read. Bật ghi: gdrive folder set ${root.name} --access write`);
      return root;
    },

    invalidateAll: () => roots.clear(),
  };
}
