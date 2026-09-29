// 迁移响应校验：迁移模式的成功响应必须“属于当前矩阵、属于本次参考、
// 且能在当前矩阵上完整复算”，才允许上屏成为可操作的新接线。
//
// 校验内容：
//   1. 身份：mode 必须是迁移响应，响应 n 与当前矩阵维度一致；
//   2. 结构：assignment 是长度 n 的 0..n-1 合法排列，且不命中禁配格；
//   3. 可复算：totalCost 为非负安全整数，与按当前矩阵逐项复算精确相等；
//   4. 变更行：changedRows 为 0..n 的安全整数，且与 assignment 相对当前参考
//      逐行比对的结果精确相等（响应必须能按当前矩阵 + 当前参考复算）；
//   5. 归属：回显 reference 必须与当前参考逐行一致，防止迟到/错串响应顶替。
//
// 迁移响应不携带 pairFlags；这里也不接受任何必然/可替换标记
// （迁移模式不得沿用旧方案的必然标记）。
//
// 返回 { ok: true, assignment, totalCost, changedRows, reference }
// 或 { ok: false, reason }。校验失败时调用方必须清除结果且不得展示可操作接线。

export function validateMigrationResponse(data, costs, reference) {
  const n = Array.isArray(costs) ? costs.length : 0;
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { ok: false, reason: '响应体不是 JSON 对象' };
  }
  if (data.mode !== 'migrate') {
    return { ok: false, reason: `响应 mode=${String(data.mode)} 不是迁移模式` };
  }
  if (!Number.isInteger(data.n) || data.n !== n) {
    return { ok: false, reason: `响应 n=${String(data.n)} 与当前矩阵 n=${n} 不符` };
  }
  if (!Array.isArray(reference) || reference.length !== n) {
    return { ok: false, reason: '当前缺少与矩阵同规模的旧接线参考' };
  }

  const { assignment, totalCost, changedRows } = data;
  if (!Array.isArray(assignment) || assignment.length !== n) {
    return { ok: false, reason: `assignment 缺失或长度与 n=${n} 不符` };
  }
  const used = new Set();
  let sum = 0;
  let changed = 0;
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
    if (j !== reference[i]) changed++;
  }

  if (!Number.isSafeInteger(totalCost) || totalCost < 0) {
    return { ok: false, reason: 'totalCost 不是非负安全整数' };
  }
  if (sum !== totalCost) {
    return { ok: false, reason: `totalCost=${totalCost} 与按当前矩阵复算的总价 ${sum} 不一致` };
  }

  if (!Number.isSafeInteger(changedRows) || changedRows < 0 || changedRows > n) {
    return { ok: false, reason: `changedRows 不是 0..${n} 的整数` };
  }
  if (changedRows !== changed) {
    return {
      ok: false,
      reason: `changedRows=${changedRows} 与按当前参考复算的变更行数 ${changed} 不一致`,
    };
  }

  // 回显参考必须与当前参考逐行一致：迟到响应或参考已更换时不得顶替上屏。
  if (!Array.isArray(data.reference) || data.reference.length !== n) {
    return { ok: false, reason: '响应缺少与 n 等长的 reference 回显，无法核对归属' };
  }
  for (let i = 0; i < n; i++) {
    if (data.reference[i] !== reference[i]) {
      return { ok: false, reason: `响应回显的参考在第 ${i + 1} 行与当前旧接线参考不一致` };
    }
  }

  return {
    ok: true,
    assignment,
    totalCost,
    changedRows,
    reference: reference.slice(),
  };
}
