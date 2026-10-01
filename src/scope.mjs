// Lớp phạm vi: một file chỉ được đọc/ghi khi nó, hoặc một tổ tiên theo `parents`, là
// folder trong danh sách. Kết quả lần theo tổ tiên cache 10 phút.
//
// Shortcut được coi là file ĐÍCH của nó: shortcut nằm trong folder được phép nhưng trỏ ra
// ngoài vẫn bị từ chối — nếu không, một shortcut do ai đó tạo là đủ để đọc file lạ.

import { createTtlCache } from './cache.mjs';
import { FOLDER_NAME_RE } from './folders.mjs';
import { parseGoogleUrl } from './url.mjs';

const MIME_FOLDER = 'application/vnd.google-apps.folder';
const MIME_SHORTCUT = 'application/vnd.google-apps.shortcut';
const MAX_DEPTH = 32;
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

  /** Folder gốc chứa `id`, hoặc null. Cache cho mọi id đi qua trên đường lên. */
  async function rootOf(id, depth = 0, seen = new Set()) {
    if (byId.has(id)) return byId.get(id);
    const cached = roots.get(id);
    if (cached !== undefined) return cached;
    if (depth >= MAX_DEPTH || seen.has(id)) return null;
    seen.add(id);

    const m = await meta.file(id);
    let root = null;
    for (const parent of m.parents ?? []) {
      try {
        root = await rootOf(parent, depth + 1, seen);
      } catch (err) {
        // Folder cha không truy cập được (404) chỉ có nghĩa nhánh đó không dẫn tới folder
        // được phép — vẫn xét các parent còn lại. Lỗi khác (mạng, 5xx) thì ném lên.
        if (!isNotFound(err)) throw err;
        root = null;
      }
      if (root) break;
    }
    roots.set(id, root);
    return root;
  }

  async function resolveTarget(id) {
    let m = await meta.file(id);
    if (m.mimeType === MIME_SHORTCUT && m.shortcutDetails?.targetId) {
      m = await meta.file(m.shortcutDetails.targetId);
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
