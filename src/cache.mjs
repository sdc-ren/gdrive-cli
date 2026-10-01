// Cache TTL trong tiến trình. Dùng cho metadata Drive/Sheets và kết quả lần theo folder cha,
// để lần đọc lặp lại một file không tốn thêm vòng mạng.

export function createTtlCache({ ttlMs, now = Date.now, max = 2000 } = {}) {
  const store = new Map(); // key → { value, expiresAt }
  const inflight = new Map(); // key → Promise

  const alive = (entry) => entry && entry.expiresAt > now();

  function set(key, value) {
    store.delete(key);
    store.set(key, { value, expiresAt: now() + ttlMs });
    // Map giữ thứ tự chèn: entry đầu là cũ nhất.
    while (store.size > max) store.delete(store.keys().next().value);
  }

  function get(key) {
    const entry = store.get(key);
    if (alive(entry)) return entry.value;
    store.delete(key);
    return undefined;
  }

  return {
    get,
    set,
    delete: (key) => {
      store.delete(key);
      inflight.delete(key);
    },
    clear: () => {
      store.clear();
      inflight.clear();
    },
    async getOrLoad(key, loader) {
      const hit = get(key);
      if (hit !== undefined) return hit;
      if (inflight.has(key)) return inflight.get(key);
      const p = (async () => {
        try {
          const value = await loader();
          set(key, value);
          return value;
        } finally {
          inflight.delete(key);
        }
      })();
      inflight.set(key, p);
      return p;
    },
  };
}
