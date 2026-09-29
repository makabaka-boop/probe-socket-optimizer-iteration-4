// 输入校验：{ costs: n×n 数组，n∈[1,400]；元素为 null 或 [0,1e12] 的整数 }。
// 任何不满足条件（缺行、错维度、越界、非整数等）都返回 false。

export const MAX_N = 400;
export const MAX_COST = 1_000_000_000_000; // 1e12

export function validateCosts(body) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, reason: '请求体必须是 JSON 对象' };
  }
  const { costs } = body;
  if (!Array.isArray(costs)) {
    return { ok: false, reason: '缺少 costs 数组字段' };
  }
  const n = costs.length;
  if (!Number.isInteger(n) || n < 1 || n > MAX_N) {
    return { ok: false, reason: `n 必须为 1 到 ${MAX_N} 的整数` };
  }
  for (let i = 0; i < n; i++) {
    const row = costs[i];
    if (!Array.isArray(row)) {
      return { ok: false, reason: `第 ${i + 1} 行不是数组（缺行）` };
    }
    if (row.length !== n) {
      return { ok: false, reason: `第 ${i + 1} 行长度 ${row.length} 与 n=${n} 不一致（错维度）` };
    }
    for (let j = 0; j < n; j++) {
      const c = row[j];
      if (c === null) continue;
      if (typeof c !== 'number' || !Number.isInteger(c)) {
        return { ok: false, reason: `代价 [${i + 1},${j + 1}] 不是整数或 null` };
      }
      if (c < 0 || c > MAX_COST) {
        return { ok: false, reason: `代价 [${i + 1},${j + 1}] 越界（允许 0 到 ${MAX_COST}）` };
      }
    }
  }
  return { ok: true, n };
}
