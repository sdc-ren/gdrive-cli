// Google Drive API v3 — get/list/export/download/upload/permission.
//
// Mọi lời gọi đều mang supportsAllDrives=true: service account KHÔNG có dung lượng My
// Drive, nên thực tế file hữu ích đều nằm trên Shared Drive.

import { randomUUID } from 'node:crypto';

import { buildQuery, GoogleApiError } from './http.mjs';

const BASE = 'https://www.googleapis.com/drive/v3';
const UPLOAD_BASE = 'https://www.googleapis.com/upload/drive/v3';

// Ngưỡng Google khuyến nghị chuyển sang resumable.
const MULTIPART_LIMIT = 5 * 1024 * 1024;

// Timeout cho tải/xuất nội dung: timeout của request bao cả lúc đọc body nên 30 s mặc định
// sẽ cắt ngang file lớn. Chỗ gọi ghi đè được; 0 = không timeout (CLI: người dùng tự chờ).
const DOWNLOAD_TIMEOUT_MS = 120_000;

/** Timeout cho upload theo kích thước: giả định mạng tối thiểu 256 KiB/s, sàn 120 s. */
export const transferTimeoutMs = (bytes) => Math.max(120_000, Math.ceil(bytes / (256 * 1024)) * 1000);

export const FILE_FIELDS =
  'id,name,mimeType,size,modifiedTime,webViewLink,webContentLink,driveId,parents,' +
  'capabilities(canAddChildren,canDownload),exportLinks,shortcutDetails';

const SHARED_DRIVE_PARAMS = { supportsAllDrives: true };
const LIST_PARAMS = { supportsAllDrives: true, includeItemsFromAllDrives: true };

/** Escape giá trị nhét vào query `q` của Drive. */
export function escapeQueryValue(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

export async function getFile(client, fileId, { fields = FILE_FIELDS } = {}) {
  return client.api({
    url: `${BASE}/files/${encodeURIComponent(fileId)}${buildQuery({ fields, ...SHARED_DRIVE_PARAMS })}`,
  });
}

export async function about(client) {
  return client.api({
    url: `${BASE}/about${buildQuery({ fields: 'user(emailAddress,displayName),storageQuota' })}`,
  });
}

/**
 * @param {object} opts
 * @param {string} [opts.folderId]      giới hạn trong một thư mục
 * @param {string} [opts.nameContains]  lọc theo tên
 * @param {string} [opts.mimeType]
 * @param {string} [opts.query]         mệnh đề `q` thô, AND với các điều kiện trên
 * @param {boolean} [opts.trashed]      mặc định false
 */
export async function listFiles(
  client,
  { folderId = null, nameContains = null, mimeType = null, query = null, trashed = false, max = 50, pageToken = null } = {},
) {
  const clauses = [];
  if (folderId) clauses.push(`'${escapeQueryValue(folderId)}' in parents`);
  if (nameContains) clauses.push(`name contains '${escapeQueryValue(nameContains)}'`);
  if (mimeType) clauses.push(`mimeType = '${escapeQueryValue(mimeType)}'`);
  if (trashed === false) clauses.push('trashed = false');
  if (query) clauses.push(`(${query})`);

  const data = await client.api({
    url: `${BASE}/files${buildQuery({
      q: clauses.length ? clauses.join(' and ') : undefined,
      fields: `nextPageToken,files(${FILE_FIELDS})`,
      pageSize: Math.min(Math.max(max, 1), 1000),
      orderBy: 'modifiedTime desc',
      pageToken,
      ...LIST_PARAMS,
    })}`,
  });
  return { files: data.files ?? [], nextPageToken: data.nextPageToken ?? null };
}

/** Tải nội dung nhị phân của file đã upload (không phải file native của Google). */
export async function downloadFile(client, fileId, { timeoutMs = DOWNLOAD_TIMEOUT_MS } = {}) {
  return client.api({
    url: `${BASE}/files/${encodeURIComponent(fileId)}${buildQuery({ alt: 'media', ...SHARED_DRIVE_PARAMS })}`,
    responseType: 'buffer',
    // Timeout tính cả lúc đọc body — file lớn cần rộng hơn mặc định 30 s.
    timeoutMs,
  });
}

/** Xuất file native của Google (Docs/Sheets/Slides) sang một mimeType khác. */
export async function exportFile(client, fileId, mimeType, { timeoutMs = DOWNLOAD_TIMEOUT_MS } = {}) {
  return client.api({
    url: `${BASE}/files/${encodeURIComponent(fileId)}/export${buildQuery({ mimeType })}`,
    responseType: 'buffer',
    timeoutMs,
  });
}

/**
 * Kiểm tra thư mục đích TRƯỚC khi upload, để trả lỗi nói đúng bệnh thay vì để Google ném
 * ra 403 storageQuotaExceeded khó hiểu.
 */
export async function assertUploadableFolder(client, folderId) {
  const folder = await getFile(client, folderId, {
    fields: 'id,name,mimeType,driveId,capabilities(canAddChildren)',
  });
  if (!folder.driveId) {
    const err = new Error(
      `Thư mục "${folder.name}" nằm trên My Drive, không phải Shared Drive.\n` +
        'Service account KHÔNG có dung lượng My Drive nên mọi thao tác ghi vào đó đều thất bại ' +
        '(403 storageQuotaExceeded), kể cả khi đã share quyền Editor.\n' +
        'Cách xử lý: tạo một Shared Drive, thêm service account làm thành viên, rồi upload vào đó.',
    );
    err.code = 'NOT_SHARED_DRIVE';
    throw err;
  }
  if (folder.capabilities && folder.capabilities.canAddChildren === false) {
    const err = new Error(
      `Service account không có quyền tạo file trong "${folder.name}" — cần vai trò Content manager trở lên.`,
    );
    err.code = 'NO_ADD_CHILDREN';
    throw err;
  }
  return folder;
}

function multipartBody(metadata, content, contentType, boundary) {
  const head = Buffer.from(
    `--${boundary}\r\ncontent-type: application/json; charset=UTF-8\r\n\r\n` +
      `${JSON.stringify(metadata)}\r\n` +
      `--${boundary}\r\ncontent-type: ${contentType}\r\n\r\n`,
    'utf8',
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8');
  return Buffer.concat([head, Buffer.from(content), tail]);
}

/**
 * Upload một buffer lên Drive. <5MB đi multipart, lớn hơn đi resumable.
 * `convertTo` (mimeType native của Google) bắt Drive chuyển đổi khi nhận.
 */
export async function uploadFile(
  client,
  { name, folderId, content, mimeType = 'application/octet-stream', convertTo = null },
) {
  const metadata = { name, ...(folderId ? { parents: [folderId] } : {}) };
  const params = { fields: FILE_FIELDS, ...SHARED_DRIVE_PARAMS };
  if (convertTo) metadata.mimeType = convertTo;

  const buffer = Buffer.from(content);

  if (buffer.length < MULTIPART_LIMIT) {
    // Boundary phải không xuất hiện trong nội dung — UUID ngẫu nhiên là cách rẻ nhất.
    const boundary = `gdrive-cli-${randomUUID()}`;
    return client.api({
      url: `${UPLOAD_BASE}/files${buildQuery({ uploadType: 'multipart', ...params })}`,
      method: 'POST',
      idempotent: false,
      timeoutMs: transferTimeoutMs(buffer.length),
      body: multipartBody(metadata, buffer, mimeType, boundary),
      headers: { 'content-type': `multipart/related; boundary=${boundary}` },
    });
  }

  const initRes = await client.api({
    url: `${UPLOAD_BASE}/files${buildQuery({ uploadType: 'resumable', ...params })}`,
    method: 'POST',
    idempotent: false,
    body: metadata,
    headers: {
      'x-upload-content-type': mimeType,
      'x-upload-content-length': String(buffer.length),
    },
    responseType: 'raw',
  });
  const location = initRes.headers.get('location');
  if (!location) {
    throw new GoogleApiError(initRes.status, { error: { message: 'Resumable upload không trả về Location header.' } }, { url: initRes.url, method: 'POST' });
  }
  return client.api({
    url: location,
    method: 'PUT',
    idempotent: false,
    timeoutMs: transferTimeoutMs(buffer.length),
    body: buffer,
    headers: { 'content-type': mimeType, 'content-length': String(buffer.length) },
  });
}

/** Cấp quyền. Chỉ gọi khi người dùng yêu cầu tường minh — không bao giờ mặc định. */
export async function shareFile(client, fileId, { role = 'reader', type = 'anyone' } = {}) {
  return client.api({
    url: `${BASE}/files/${encodeURIComponent(fileId)}/permissions${buildQuery(SHARED_DRIVE_PARAMS)}`,
    method: 'POST',
    idempotent: false,
    body: { role, type },
  });
}

export async function createFolder(client, { name, parentId = null }) {
  return client.api({
    url: `${BASE}/files${buildQuery({ fields: FILE_FIELDS, ...SHARED_DRIVE_PARAMS })}`,
    method: 'POST',
    idempotent: false,
    body: {
      name,
      mimeType: 'application/vnd.google-apps.folder',
      ...(parentId ? { parents: [parentId] } : {}),
    },
  });
}

/** Đổi tên và/hoặc chuyển folder. PATCH là idempotent nên thử lại thoải mái. */
export async function updateFile(client, fileId, { name = null, addParents = null, removeParents = null } = {}) {
  return client.api({
    url: `${BASE}/files/${encodeURIComponent(fileId)}${buildQuery({
      fields: 'id,name,parents',
      addParents: addParents ?? undefined,
      removeParents: removeParents ?? undefined,
      ...SHARED_DRIVE_PARAMS,
    })}`,
    method: 'PATCH',
    body: name ? { name } : {},
  });
}

/** Tìm thư mục con theo tên, chưa có thì tạo. Dùng cho folder theo ngày khi upload artifact. */
export async function ensureFolder(client, { name, parentId }) {
  const { files } = await listFiles(client, {
    folderId: parentId,
    nameContains: name,
    mimeType: 'application/vnd.google-apps.folder',
    max: 100,
  });
  const exact = files.find((f) => f.name === name);
  if (exact) return exact;
  return createFolder(client, { name, parentId });
}
