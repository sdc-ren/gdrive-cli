// Đọc ZIP bằng node:zlib — đủ để mở .xlsx/.docx/.pptx mà không cần thư viện ngoài.
//
// Chỉ hỗ trợ ĐỌC, và chỉ 2 method Office thực sự dùng: 0 (stored) và 8 (deflate).

import { inflateRawSync } from 'node:zlib';

const SIG_EOCD = 0x06054b50;
const SIG_EOCD64 = 0x06064b50;
const SIG_EOCD64_LOCATOR = 0x07064b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_LOCAL = 0x04034b50;

const EOCD_MIN = 22;
const MAX_COMMENT = 0xffff;
const CENTRAL_FIXED = 46;
const LOCAL_FIXED = 30;

const FLAG_ENCRYPTED = 0x0001;
const FLAG_UTF8_NAME = 0x0800;

const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;

export class ZipError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ZipError';
  }
}

/** EOCD nằm ở cuối file nhưng có thể bị đẩy lùi tới 64KB bởi trường comment → quét NGƯỢC. */
function findEocd(buf) {
  const start = Math.max(0, buf.length - (EOCD_MIN + MAX_COMMENT));
  for (let i = buf.length - EOCD_MIN; i >= start; i--) {
    if (buf.readUInt32LE(i) === SIG_EOCD) return i;
  }
  throw new ZipError('Không tìm thấy End of Central Directory — file không phải ZIP hoặc đã hỏng.');
}

function readEocd(buf) {
  const at = findEocd(buf);
  let entries = buf.readUInt16LE(at + 10);
  let cdSize = buf.readUInt32LE(at + 12);
  let cdOffset = buf.readUInt32LE(at + 16);

  // Giá trị "tràn" ⇒ số thật nằm trong bản ghi ZIP64.
  const needsZip64 = entries === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff;
  if (needsZip64) {
    const locAt = at - 20;
    if (locAt < 0 || buf.readUInt32LE(locAt) !== SIG_EOCD64_LOCATOR) {
      throw new ZipError('File cần ZIP64 nhưng thiếu ZIP64 EOCD locator.');
    }
    const eocd64At = Number(buf.readBigUInt64LE(locAt + 8));
    if (buf.readUInt32LE(eocd64At) !== SIG_EOCD64) {
      throw new ZipError('ZIP64 EOCD locator trỏ sai chỗ.');
    }
    entries = Number(buf.readBigUInt64LE(eocd64At + 32));
    cdSize = Number(buf.readBigUInt64LE(eocd64At + 40));
    cdOffset = Number(buf.readBigUInt64LE(eocd64At + 48));
  }

  return { entries, cdSize, cdOffset };
}

/**
 * Trường extra ZIP64 (id 0x0001) chỉ chứa những giá trị ĐÃ tràn, theo đúng thứ tự
 * uncompressed → compressed → localHeaderOffset → diskStart. Đọc sai thứ tự = lệch hết.
 */
function applyZip64Extra(extra, entry) {
  let p = 0;
  while (p + 4 <= extra.length) {
    const id = extra.readUInt16LE(p);
    const size = extra.readUInt16LE(p + 2);
    if (id === 0x0001) {
      let q = p + 4;
      if (entry.uncompressedSize === 0xffffffff && q + 8 <= p + 4 + size) {
        entry.uncompressedSize = Number(extra.readBigUInt64LE(q));
        q += 8;
      }
      if (entry.compressedSize === 0xffffffff && q + 8 <= p + 4 + size) {
        entry.compressedSize = Number(extra.readBigUInt64LE(q));
        q += 8;
      }
      if (entry.localHeaderOffset === 0xffffffff && q + 8 <= p + 4 + size) {
        entry.localHeaderOffset = Number(extra.readBigUInt64LE(q));
        q += 8;
      }
      return;
    }
    p += 4 + size;
  }
}

/**
 * Đọc central directory thành Map<tên, entry>.
 *
 * Cố ý duyệt CENTRAL DIRECTORY chứ không phải local header: khi bit 3 (data descriptor)
 * bật — PowerPoint bật rất thường xuyên — local header ghi size = 0, chỉ central directory
 * mới có số đúng.
 */
export function openZip(buffer, { maxInflateBytes = 256 * 1024 * 1024 } = {}) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  const { entries: count, cdOffset } = readEocd(buf);

  const entries = new Map();
  let p = cdOffset;

  for (let i = 0; i < count; i++) {
    if (p + CENTRAL_FIXED > buf.length || buf.readUInt32LE(p) !== SIG_CENTRAL) {
      throw new ZipError(`Central directory hỏng ở entry thứ ${i + 1}.`);
    }
    const flags = buf.readUInt16LE(p + 8);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);

    const entry = {
      name: buf
        .subarray(p + CENTRAL_FIXED, p + CENTRAL_FIXED + nameLen)
        .toString(flags & FLAG_UTF8_NAME ? 'utf8' : 'latin1'),
      flags,
      method: buf.readUInt16LE(p + 10),
      compressedSize: buf.readUInt32LE(p + 20),
      uncompressedSize: buf.readUInt32LE(p + 24),
      localHeaderOffset: buf.readUInt32LE(p + 42),
    };

    if (extraLen) {
      applyZip64Extra(buf.subarray(p + CENTRAL_FIXED + nameLen, p + CENTRAL_FIXED + nameLen + extraLen), entry);
    }

    entries.set(entry.name, entry);
    p += CENTRAL_FIXED + nameLen + extraLen + commentLen;
  }

  return {
    entries,
    names: () => [...entries.keys()],
    has: (name) => entries.has(name),
    /** Giải nén một entry. Trả Buffer, hoặc null nếu không có entry đó. */
    read: (name) => {
      const entry = entries.get(name);
      return entry ? readEntry(buf, entry, maxInflateBytes) : null;
    },
    /** Giải nén rồi decode UTF-8 (mọi part XML của OOXML đều là UTF-8). */
    readText: (name) => {
      const entry = entries.get(name);
      return entry ? readEntry(buf, entry, maxInflateBytes).toString('utf8') : null;
    },
  };
}

/** maxInflateBytes: trần dung lượng sau giải nén — chặn zip bomb làm cạn RAM. */
function readEntry(buf, entry, maxInflateBytes) {
  if (entry.flags & FLAG_ENCRYPTED) {
    throw new ZipError(`"${entry.name}" được đặt mật khẩu — không đọc được.`);
  }
  if (buf.readUInt32LE(entry.localHeaderOffset) !== SIG_LOCAL) {
    throw new ZipError(`Local header của "${entry.name}" hỏng.`);
  }

  // BẮT BUỘC lấy nameLen/extraLen từ LOCAL header, không phải central directory: hai chỗ
  // này thường xuyên khác nhau (local hay có thêm extra field căn lề). Dùng nhầm số của
  // central directory là lỗi #1 của mọi ZIP reader tự viết — data lệch vài byte rồi
  // inflate ném "invalid stored block lengths".
  const nameLen = buf.readUInt16LE(entry.localHeaderOffset + 26);
  const extraLen = buf.readUInt16LE(entry.localHeaderOffset + 28);
  const start = entry.localHeaderOffset + LOCAL_FIXED + nameLen + extraLen;
  const data = buf.subarray(start, start + entry.compressedSize);

  if (entry.method === METHOD_STORE) return Buffer.from(data);
  if (entry.method === METHOD_DEFLATE) {
    // inflateRAW: dữ liệu trong ZIP là deflate trần, KHÔNG có header zlib 2 byte.
    try {
      return inflateRawSync(data, { maxOutputLength: maxInflateBytes });
    } catch (err) {
      if (err?.code === 'ERR_BUFFER_TOO_LARGE' || /maxOutputLength|Cannot create a Buffer larger/i.test(String(err?.message))) {
        throw new ZipError(`"${entry.name}" giải nén quá lớn (trên ${Math.round(maxInflateBytes / 1024 / 1024)} MB) — từ chối để tránh zip bomb.`);
      }
      throw new ZipError(`"${entry.name}" giải nén lỗi: ${err?.message ?? err}`);
    }
  }
  throw new ZipError(
    `"${entry.name}" nén bằng method ${entry.method} (chỉ hỗ trợ 0=stored và 8=deflate).`,
  );
}
