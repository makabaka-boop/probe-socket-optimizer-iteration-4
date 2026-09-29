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
//   5. 迁移（expectedReference 非 null）：本次请求带了旧接线参考，
//      响应必须回显同一参考，并给出与 assignment 逐项对应的 changedRows
//      （0..n-1 互不重复、升序）与 changedCount；任何一项不符都按协议错误处理，
//      绝不展示归属不明或变更数无法复算的“新接线”。
//
// 返回 { ok: true, assignment, totalCost, pairFlags, migration } 或 { ok: false, reason }。
// migration 为 null（普通模式）或 { reference, changedRows, changedCount }。
// 校验失败时调用方必须清除旧方案与旧高亮，且不得允许继续排除。

export function validateSolveResponse(data, costs, expectedReference = null) {
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
  let pairFlags = null;
  if (data.pairFlags !== undefined) {
    const flags = data.pairFlags;
    if (!Array.isArray(flags) || flags.length !== n) {
      return { ok: false, reason: `pairFlags 字段存在但不是长度 ${n} 的数组` };
    }
    pairFlags = new Array(n);
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
  }

  // 普通模式（请求未带参考）：不要求迁移字段，额外字段一律忽略（旧/新服务互兼容）。
  if (expectedReference === null) {
    return { ok: true, assignment, totalCost, pairFlags, migration: null };
  }

  // 迁移模式：回显参考必须与本次固定的参考逐行一致（迟到/串台响应在此被拦下）。
  const migration = validateMigrationFields(data, assignment, expectedReference);
  if (!migration.ok) return migration;
  return { ok: true, assignment, totalCost, pairFlags, migration: migration.value };
}

// 迁移字段校验：reference 回显身份、changedRows 结构及其与 assignment/reference 的对应。
function validateMigrationFields(data, assignment, expectedReference) {
  const n = expectedReference.length;
  const { reference, changedRows, changedCount } = data;

  if (!Array.isArray(reference) || reference.length !== n) {
    return { ok: false, reason: `迁移响应缺少回显 reference 或长度不是 ${n}` };
  }
  for (let i = 0; i < n; i++) {
    if (reference[i] !== expectedReference[i]) {
      return { ok: false, reason: `回显 reference[${i}]=${String(reference[i])} 与本次固定参考不一致（结果归属不明）` };
    }
  }

  if (!Array.isArray(changedRows)) {
    return { ok: false, reason: '迁移响应缺少 changedRows 数组' };
  }
  const expectedChanged = [];
  for (let i = 0; i < n; i++) {
    if (assignment[i] !== reference[i]) expectedChanged.push(i);
  }
  if (changedRows.length !== expectedChanged.length) {
    return {
      ok: false,
      reason: `changedRows 行数 ${changedRows.length} 与按参考复算的变更行数 ${expectedChanged.length} 不一致`,
    };
  }
  let prev = -1;
  const rowSet = new Set();
  for (const r of changedRows) {
    // 必须为 0..n-1 的整数、互不重复且升序（服务端契约：升序，防重复/伪造）。
    if (!Number.isInteger(r) || r < 0 || r >= n) {
      return { ok: false, reason: `changedRows 含非法行下标 ${String(r)}` };
    }
    if (r <= prev) {
      return { ok: false, reason: 'changedRows 必须互不重复且按行号升序' };
    }
    prev = r;
    rowSet.add(r);
  }
  for (const r of expectedChanged) {
    if (!rowSet.has(r)) {
      return { ok: false, reason: `changedRows 缺少实际变更行 ${r + 1}` };
    }
  }

  if (!Number.isSafeInteger(changedCount) || changedCount !== expectedChanged.length) {
    return {
      ok: false,
      reason: `changedCount=${String(changedCount)} 与复算变更行数 ${expectedChanged.length} 不一致`,
    };
  }

  return {
    ok: true,
    value: {
      reference: reference.slice(),
      changedRows: changedRows.slice(),
      changedCount,
    },
  };
}
