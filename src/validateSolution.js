// 求解响应校验：老化台可能经代理、缓存或滚动升级中的旧服务拿到响应，
// 只有“属于当前矩阵且能完整复算”的方案才允许上屏成为可操作方案。
//
// 校验内容（全部针对本次请求实际发送的 costs 矩阵）：
//   1. 身份：响应 n 与当前矩阵维度一致；
//   2. 结构：assignment 是长度 n 的数组，每项为 0..n-1 的整数列下标，
//      列不重复（合法排列），且不命中禁配格；
//   3. 可复算：totalCost 为非负安全整数，且与 assignment 对原矩阵
//      逐项求和的结果精确相等；
//   4. 标记：pairFlags 完全缺失时视为旧版合法响应（pairFlags=null，
//      展示分配但不显示分析标记）；字段一旦存在，必须是长度 n 的数组，
//      每项 { forced: boolean, alternatives: 0..n-1 整数 } 且
//      forced ⇔ alternatives===0，与本次 assignment 逐行完整对应。
//
// 返回 { ok: true, assignment, totalCost, pairFlags } 或 { ok: false, reason }。
// 校验失败时调用方必须清除旧方案与旧高亮，且不得允许继续排除。

export function validateSolveResponse(data, costs) {
  const n = Array.isArray(costs) ? costs.length : 0;
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { ok: false, reason: '响应体不是 JSON 对象' };
  }
  if (!Number.isInteger(data.n) || data.n !== n) {
    return { ok: false, reason: `响应 n=${String(data.n)} 与当前矩阵 n=${n} 不符` };
  }

  const { assignment, totalCost } = data;
  if (!Array.isArray(assignment) || assignment.length !== n) {
    return { ok: false, reason: `assignment 缺失或长度与 n=${n} 不符` };
  }
  const used = new Set();
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const j = assignment[i];
    if (!Number.isInteger(j) || j < 0 || j >= n) {
      return { ok: false, reason: `assignment[${i}]=${String(j)} 不是 0..${n - 1} 的整数列下标` };
    }
    if (used.has(j)) {
      return { ok: false, reason: `assignment 中列 ${j + 1} 重复，不是合法排列` };
    }
    used.add(j);
    const c = costs[i][j];
    if (typeof c !== 'number' || !Number.isInteger(c)) {
      return { ok: false, reason: `assignment[${i}] 命中禁配格（探针 ${i + 1} → 座 ${j + 1}）` };
    }
    sum += c;
  }

  if (!Number.isSafeInteger(totalCost) || totalCost < 0) {
    return { ok: false, reason: 'totalCost 不是非负安全整数' };
  }
  if (sum !== totalCost) {
    return { ok: false, reason: `totalCost=${totalCost} 与按当前矩阵复算的总价 ${sum} 不一致` };
  }

  // 旧版服务：完全缺少 pairFlags 字段，合法，仅不展示分析标记。
  if (data.pairFlags === undefined) {
    return { ok: true, assignment, totalCost, pairFlags: null };
  }
  const flags = data.pairFlags;
  if (!Array.isArray(flags) || flags.length !== n) {
    return { ok: false, reason: `pairFlags 字段存在但不是长度 ${n} 的数组` };
  }
  const pairFlags = new Array(n);
  for (let i = 0; i < n; i++) {
    const f = flags[i];
    if (!f || typeof f !== 'object' || Array.isArray(f)) {
      return { ok: false, reason: `pairFlags[${i}] 不是 { forced, alternatives } 对象` };
    }
    if (typeof f.forced !== 'boolean') {
      return { ok: false, reason: `pairFlags[${i}].forced 不是布尔值` };
    }
    if (!Number.isSafeInteger(f.alternatives) || f.alternatives < 0 || f.alternatives > n - 1) {
      return { ok: false, reason: `pairFlags[${i}].alternatives 不是 0..${n - 1} 的整数` };
    }
    if (f.forced !== (f.alternatives === 0)) {
      return { ok: false, reason: `pairFlags[${i}] 的 forced 与 alternatives 相互矛盾` };
    }
    pairFlags[i] = { forced: f.forced, alternatives: f.alternatives };
  }
  return { ok: true, assignment, totalCost, pairFlags };
}
