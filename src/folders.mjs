// Danh sách folder được phép — lớp phạm vi của plugin.
//
// Mỗi folder có tên gợi nhớ (model gọi `drive_ls test-run` thay vì dán id) và quyền
// read|write. Nguồn: khoá `folders` trong config, hoặc biến GDRIVE_FOLDERS cho CI
// ("name=id:access,name2=id2"). Env thắng config để pipeline không phải sửa file.

export const FOLDER_NAME_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
export const ACCESS_LEVELS = ['read', 'write'];

export class FolderConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'FolderConfigError';
    this.code = 'FOLDER_CONFIG';
  }
}

/** Tên folder trên Drive → tên gợi nhớ hợp lệ. Rỗng thì trả 'folder'. */
export function slugify(name) {
  const slug = String(name ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'd')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63)
    .replace(/-+$/g, '');
  return slug || 'folder';
}

export function parseFoldersEnv(value) {
  return String(value ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((item) => {
      const eq = item.indexOf('=');
      if (eq < 1) throw new FolderConfigError(`GDRIVE_FOLDERS: mục "${item}" phải có dạng name=id[:access].`);
      const name = item.slice(0, eq).trim();
      const [id, access = 'read'] = item.slice(eq + 1).split(':').map((s) => s.trim());
      return { name, id, access };
    });
}

export function validateFolders(list) {
  if (!Array.isArray(list)) throw new FolderConfigError('folders phải là một mảng.');
  const names = new Set();
  const ids = new Set();
  for (const f of list) {
    if (!f || typeof f.id !== 'string' || !f.id) throw new FolderConfigError('Folder thiếu id.');
    if (!FOLDER_NAME_RE.test(String(f.name))) {
      throw new FolderConfigError(`Tên "${f.name}" không hợp lệ: chỉ a-z, 0-9 và dấu -, tối đa 63 ký tự.`);
    }
    if (!ACCESS_LEVELS.includes(f.access)) throw new FolderConfigError(`access của "${f.name}" phải là read hoặc write.`);
    if (names.has(f.name)) throw new FolderConfigError(`Tên "${f.name}" bị trùng.`);
    if (ids.has(f.id)) throw new FolderConfigError(`Folder id ${f.id} xuất hiện hai lần.`);
    names.add(f.name);
    ids.add(f.id);
  }
  return list;
}

export function loadFolders({ config = null, env = process.env } = {}) {
  if (env.GDRIVE_FOLDERS) return validateFolders(parseFoldersEnv(env.GDRIVE_FOLDERS));
  return validateFolders(Array.isArray(config?.folders) ? config.folders : []);
}

export function addFolder(list, folder) {
  if (list.some((f) => f.name === folder.name)) throw new FolderConfigError(`Tên "${folder.name}" đã có. Chọn --name khác.`);
  if (list.some((f) => f.id === folder.id)) throw new FolderConfigError(`Folder này đã có trong danh sách (tên "${list.find((f) => f.id === folder.id).name}").`);
  return validateFolders([...list, folder]);
}

function mustFind(list, name) {
  if (!list.some((f) => f.name === name)) {
    throw new FolderConfigError(`Không có folder tên "${name}". Có: ${list.map((f) => f.name).join(', ') || '(trống)'}.`);
  }
}

export function removeFolder(list, name) {
  mustFind(list, name);
  return list.filter((f) => f.name !== name);
}

export function setAccess(list, name, access) {
  mustFind(list, name);
  return validateFolders(list.map((f) => (f.name === name ? { ...f, access } : f)));
}
