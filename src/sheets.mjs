// Google Sheets API v4 — chỉ những endpoint thực sự dùng tới.

import { buildQuery } from './http.mjs';
import { buildA1 } from './url.mjs';

const BASE = 'https://sheets.googleapis.com/v4/spreadsheets';

const META_FIELDS =
  'properties(title),sheets(properties(sheetId,title,index,gridProperties(rowCount,columnCount)))';

/** Metadata rút gọn: tên file + danh sách tab. */
export async function getMetadata(client, spreadsheetId, { fields = META_FIELDS } = {}) {
  const data = await client.api({
    url: `${BASE}/${encodeURIComponent(spreadsheetId)}${buildQuery({ fields })}`,
  });
  return {
    title: data.properties?.title ?? null,
    sheets: (data.sheets ?? []).map((s) => ({
      gid: String(s.properties?.sheetId ?? ''),
      title: s.properties?.title ?? '',
      index: s.properties?.index ?? 0,
      rows: s.properties?.gridProperties?.rowCount ?? 0,
      cols: s.properties?.gridProperties?.columnCount ?? 0,
    })),
  };
}

export class SheetNotFoundError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SheetNotFoundError';
  }
}

/**
 * Chọn tab theo (ưu tiên giảm dần): `sheet` người dùng chỉ định → `gid` bóc từ URL → tab đầu.
 *
 * `sheet` là số ⇒ hiểu là gid; là chữ ⇒ hiểu là tên tab (khớp chính xác trước, rồi
 * case-insensitive). Trả về cả danh sách tab để chỗ gọi in ra khi đoán sai.
 */
export function pickSheet(sheets, { sheet = null, gid = null } = {}) {
  if (!sheets.length) throw new SheetNotFoundError('Spreadsheet không có tab nào.');

  const byGid = (value) => sheets.find((s) => s.gid === String(value));

  if (sheet !== null && sheet !== undefined && sheet !== '') {
    const asString = String(sheet);
    if (/^\d+$/.test(asString)) {
      const hit = byGid(asString);
      if (hit) return hit;
      // Số nhưng không khớp gid nào → có thể người dùng đặt tên tab là số.
    }
    const exact = sheets.find((s) => s.title === asString);
    if (exact) return exact;
    const ci = sheets.find((s) => s.title.toLowerCase() === asString.toLowerCase());
    if (ci) return ci;
    throw new SheetNotFoundError(
      `Không có tab nào tên/gid "${asString}". Các tab hiện có: ` +
        sheets.map((s) => `${s.title} (gid=${s.gid})`).join(', '),
    );
  }

  if (gid) {
    const hit = byGid(gid);
    if (hit) return hit;
    throw new SheetNotFoundError(
      `URL trỏ tới gid=${gid} nhưng spreadsheet không có tab đó. Các tab hiện có: ` +
        sheets.map((s) => `${s.title} (gid=${s.gid})`).join(', '),
    );
  }

  return sheets[0];
}

export async function getValues(
  client,
  spreadsheetId,
  range,
  { valueRenderOption = 'FORMATTED_VALUE', majorDimension = 'ROWS' } = {},
) {
  const qs = buildQuery({ valueRenderOption, majorDimension });
  const data = await client.api({
    url: `${BASE}/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}${qs}`,
  });
  return data.values ?? [];
}

/**
 * Ghi nhiều range trong MỘT lần gọi.
 * Gộp lại là chủ ý: sheet-result-sync của packflow dựa vào tính chất "ô không khớp thì
 * không bị đụng tới", nên mỗi hàng phải là một range riêng chứ không ghi đè cả khối.
 *
 * @param {Array<{range: string, values: any[][]}>} data range đã là A1 đầy đủ (có tên tab)
 */
export async function batchUpdateValues(
  client,
  spreadsheetId,
  data,
  { valueInputOption = 'USER_ENTERED' } = {},
) {
  if (!data.length) return { updatedCells: 0, updatedRanges: [] };
  const res = await client.api({
    url: `${BASE}/${encodeURIComponent(spreadsheetId)}/values:batchUpdate`,
    method: 'POST',
    body: { valueInputOption, data },
  });
  return {
    updatedCells: res.totalUpdatedCells ?? 0,
    updatedRanges: (res.responses ?? []).map((r) => r.updatedRange).filter(Boolean),
  };
}

export async function appendValues(
  client,
  spreadsheetId,
  range,
  values,
  { valueInputOption = 'USER_ENTERED', insertDataOption = 'INSERT_ROWS' } = {},
) {
  const qs = buildQuery({ valueInputOption, insertDataOption });
  const res = await client.api({
    url: `${BASE}/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}:append${qs}`,
    method: 'POST',
    // Gửi lại sẽ chèn thêm hàng trùng — không được tự retry.
    idempotent: false,
    body: { values },
  });
  return {
    updatedRange: res.updates?.updatedRange ?? null,
    updatedCells: res.updates?.updatedCells ?? 0,
  };
}

/** Đọc một tab: resolve tab → lấy values. Trả kèm danh sách tab cho chỗ gọi. */
export async function readSheet(
  client,
  spreadsheetId,
  { sheet = null, gid = null, range = null, valueRenderOption = 'FORMATTED_VALUE' } = {},
) {
  const meta = await getMetadata(client, spreadsheetId);
  const picked = pickSheet(meta.sheets, { sheet, gid });
  const values = await getValues(client, spreadsheetId, buildA1(picked.title, range), {
    valueRenderOption,
  });
  return { spreadsheetTitle: meta.title, sheet: picked, sheets: meta.sheets, rows: values };
}
