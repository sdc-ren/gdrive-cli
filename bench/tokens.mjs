#!/usr/bin/env node
// Đo kích thước schema tool và kết quả mẫu. Không có tokenizer (zero dependency) nên ước
// lượng ceil(bytes/3.5); con số thật trong README đo bằng tiktoken và ghi rõ ngày đo.
// CI chạy `node bench/tokens.mjs` và đỏ khi schema vượt ngưỡng.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { INSTRUCTIONS } from '../src/instructions.mjs';
import { renderLs, renderTable } from '../src/render.mjs';
import { viewTable } from '../src/table-view.mjs';
import { buildTools } from '../src/tools.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
export const SCHEMA_TOKEN_LIMIT = 700;

export const estimateTokens = (text) => Math.ceil(Buffer.byteLength(String(text), 'utf8') / 3.5);

export function measure() {
  const schema = JSON.stringify(
    buildTools({ getClient: () => null, mode: 'readwrite' }).map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
  );
  const rows = JSON.parse(readFileSync(join(ROOT, 'test', 'fixtures', 'sample-rows.json'), 'utf8'));
  const sheet200 = renderTable({ file: 'TC_login', tab: 'Sheet1', tabs: ['Sheet1', 'Data'], view: viewTable(rows, { limit: 200 }) });
  const sheetFail = renderTable({ file: 'TC_login', tab: 'Sheet1', tabs: ['Sheet1'], view: viewTable(rows, { where: { 'Trạng thái': 'FAIL' }, columns: ['ID', 'Ghi chú'] }) });
  const ls = renderLs({
    title: 'test-run', access: 'write', total: 30, next: null,
    items: Array.from({ length: 30 }, (_, i) => ({ id: `1AbCdEfGhIjKlMnOpQrStUvWxYz${i}`, name: `report-${i}.xlsx`, mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', modifiedTime: '2026-09-30T00:00:00Z', size: '40960' })),
  });
  const sample = (name, text) => ({ name, bytes: Buffer.byteLength(text), tokens: estimateTokens(text) });
  return {
    schemaBytes: Buffer.byteLength(schema),
    schemaTokens: estimateTokens(schema),
    instructionsTokens: estimateTokens(INSTRUCTIONS),
    samples: [
      sample('drive_read sheet 200 rows', sheet200),
      sample('drive_read where FAIL, 2 columns', sheetFail),
      sample('drive_ls 30 items', ls),
    ],
  };
}

// So sánh qua pathToFileURL để đúng cả đường dẫn có ổ đĩa trên Windows (C:\...).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const m = measure();
  console.log(`schema          ${String(m.schemaBytes).padStart(7)} B  ≈ ${String(m.schemaTokens).padStart(5)} tok  (giới hạn ${SCHEMA_TOKEN_LIMIT})`);
  console.log(`instructions    ${''.padStart(7)}     ≈ ${String(m.instructionsTokens).padStart(5)} tok`);
  for (const s of m.samples) console.log(`${s.name.padEnd(36)} ${String(s.bytes).padStart(7)} B  ≈ ${String(s.tokens).padStart(5)} tok`);
  if (m.schemaTokens > SCHEMA_TOKEN_LIMIT) {
    console.error(`\n✗ schema vượt ${SCHEMA_TOKEN_LIMIT} token ước lượng — rút gọn mô tả tool.`);
    process.exit(1);
  }
}
