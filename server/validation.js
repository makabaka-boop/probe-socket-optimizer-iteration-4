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

// 迁移参考校验：reference 必须是长度恰为 n 的数组，每项为 0..n-1 的整数且列不重复
// （合法排列）。字段缺失、规模不符、越界、重复、非整数等一律整批拒绝（422），
// 在任何求解开始前返回。注意：参考边是否在新矩阵中被禁配不在此处判断——
// 旧接线即使已有禁配边，仍可用于计算变更行数。
export function validateReference(body, n) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, reason: '请求体必须是 JSON 对象' };
  }
  const { reference } = body;
  if (!Array.isArray(reference)) {
    return { ok: false, reason: '缺少 reference 数组字段（旧接线参考）' };
  }
  if (reference.length !== n) {
    return {
      ok: false,
      reason: `reference 长度 ${reference.length} 与当前矩阵 n=${n} 不一致（规模不符）`,
    };
  }
  const usedCols = new Set();
  for (let i = 0; i < n; i++) {
    const j = reference[i];
    if (typeof j !== 'number' || !Number.isInteger(j)) {
      return { ok: false, reason: `reference[${i}]=${String(j)} 不是整数列下标` };
    }
    if (j < 0 || j >= n) {
      return { ok: false, reason: `reference[${i}]=${j} 越界（允许 0..${n - 1}）` };
    }
    if (usedCols.has(j)) {
      return { ok: false, reason: `reference 中列 ${j + 1} 重复，不是合法排列` };
    }
    usedCols.add(j);
  }
  return { ok: true, reference: Array.from(reference) };
}
