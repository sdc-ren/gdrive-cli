import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createTtlCache } from '../src/cache.mjs';

test('TTL cache: hết hạn theo now(), getOrLoad dedupe loader đang chạy', async () => {
  let t = 1000;
  const cache = createTtlCache({ ttlMs: 100, now: () => t });
  cache.set('a', 1);
  assert.equal(cache.get('a'), 1);
  t += 101;
  assert.equal(cache.get('a'), undefined);

  let loads = 0;
  const loader = () => new Promise((r) => setTimeout(() => r(++loads), 5));
  const [x, y] = await Promise.all([cache.getOrLoad('b', loader), cache.getOrLoad('b', loader)]);
  assert.equal(x, 1);
  assert.equal(y, 1);
  assert.equal(loads, 1);
  assert.equal(await cache.getOrLoad('b', loader), 1, 'đã cache thì không load lại');
});

test('TTL cache: loader lỗi không để lại entry hỏng; max entries bỏ cái cũ nhất', async () => {
  const cache = createTtlCache({ ttlMs: 1000, max: 2 });
  await assert.rejects(cache.getOrLoad('x', async () => { throw new Error('boom'); }));
  assert.equal(await cache.getOrLoad('x', async () => 7), 7);
  cache.set('y', 1);
  cache.set('z', 1);
  assert.equal(cache.get('x'), undefined, 'x là entry cũ nhất, bị đẩy ra');
});

test('TTL cache: getOrLoad dùng được sau khi destructure', async () => {
  const { getOrLoad, get } = createTtlCache({ ttlMs: 1000 });
  assert.equal(await getOrLoad('k', async () => 3), 3);
  assert.equal(get('k'), 3);
});
