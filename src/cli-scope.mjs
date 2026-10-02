// Chế độ ghi cho các lệnh CLI. Quyền trên từng file do Drive quyết định (share Editor/Viewer);
// ở đây chỉ còn khoá `mode` trong config, hoặc cờ --mode cho một lần chạy.

import { modeFromConfig, READONLY_HINT } from './access.mjs';

export function resolveCliMode({ flags = {}, cfg = null, needWrite = false }) {
  const mode = flags.mode ?? modeFromConfig(cfg);
  if (needWrite && mode !== 'readwrite') {
    const e = new Error(`Đang ở chế độ readonly nên lệnh này bị từ chối. ${READONLY_HINT} (hoặc thêm --mode readwrite cho lần chạy này)`);
    e.exitCode = 3;
    throw e;
  }
  return mode;
}
