import assert from 'node:assert/strict';
import { test } from 'node:test';

import { estimateTokens, measure, SCHEMA_TOKEN_LIMIT } from '../bench/tokens.mjs';
import { MIN_NODE, nodeOk } from '../src/node-version.mjs';

test('estimateTokens theo byte/3.5', () => {
  assert.equal(estimateTokens('a'.repeat(35)), 10);
  assert.equal(estimateTokens(''), 0);
});

test('schema 5 tool dưới ngưỡng; mẫu đọc sheet 200 dòng được đo', () => {
  const m = measure();
  assert.ok(m.schemaTokens < SCHEMA_TOKEN_LIMIT, `schema ≈ ${m.schemaTokens} token (giới hạn ${SCHEMA_TOKEN_LIMIT})`);
  const sheet = m.samples.find((s) => s.name === 'drive_read sheet 200 rows');
  assert.ok(sheet.tokens > 0);
  assert.ok(m.samples.find((s) => s.name === 'drive_ls 30 items').tokens > 0);
});

test('nodeOk dùng chung: đúng biên 18.17.0', () => {
  assert.equal(MIN_NODE.major, 18);
  assert.equal(nodeOk('v18.17.0'), true);
  assert.equal(nodeOk('v18.16.9'), false);
  assert.equal(nodeOk('v22.0.0'), true);
});
