// Một chỗ duy nhất định nghĩa Node tối thiểu — server và status cùng đọc.
export const MIN_NODE = { major: 18, minor: 17, patch: 0 };

export function parseNodeVersion(version) {
  const [, major = '0', minor = '0', patch = '0'] = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(version)) ?? [];
  return { major: Number(major), minor: Number(minor), patch: Number(patch) };
}

export function nodeOk(version) {
  const got = parseNodeVersion(version);
  if (got.major !== MIN_NODE.major) return got.major > MIN_NODE.major;
  if (got.minor !== MIN_NODE.minor) return got.minor > MIN_NODE.minor;
  return got.patch >= MIN_NODE.patch;
}
