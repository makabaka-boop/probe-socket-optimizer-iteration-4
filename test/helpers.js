// 穷举 n! 种排列，取允许（非禁配）分配中的最小总代价 —— 仅用于小矩阵基准核对。
export function bruteForce(costs) {
  const n = costs.length;
  const cols = Array.from({ length: n }, (_, j) => j);
  let best = null;
  let bestPerm = null;

  const permute = (rest, picked, sum) => {
    if (rest.length === 0) {
      if (best === null || sum < best) {
        best = sum;
        bestPerm = picked.slice();
      }
      return;
    }
    const i = picked.length;
    for (let k = 0; k < rest.length; k++) {
      const j = rest[k];
      const c = costs[i][j];
      if (c === null) continue;
      picked.push(j);
      const next = rest.slice(0, k).concat(rest.slice(k + 1));
      permute(next, picked, sum + c);
      picked.pop();
    }
  };

  permute(cols, [], 0);
  return best === null ? null : { totalCost: best, assignment: bestPerm };
}

// 穷举全部可行完美匹配并保留“同价最优集合”，作为必然连线分析的独立预言机。
// 返回 null 表示不存在完美匹配；否则提供 optimalAssignments 与针对任意展示配对
// 的期望标记（forced / alternatives）。
export function bruteForceOptimalSet(costs) {
  const n = costs.length;
  const feasible = [];

  const permute = (rest, picked, sum) => {
    if (rest.length === 0) {
      feasible.push({ assignment: picked.slice(), totalCost: sum });
      return;
    }
    const i = picked.length;
    for (let k = 0; k < rest.length; k++) {
      const j = rest[k];
      const c = costs[i][j];
      if (c === null) continue;
      picked.push(j);
      const next = rest.slice(0, k).concat(rest.slice(k + 1));
      permute(next, picked, sum + c);
      picked.pop();
    }
  };

  permute(Array.from({ length: n }, (_, j) => j), [], 0);
  if (feasible.length === 0) return null;

  const totalCost = feasible.reduce((m, x) => Math.min(m, x.totalCost), Infinity);
  const optimalAssignments = feasible.filter((x) => x.totalCost === totalCost).map((x) => x.assignment);

  // 针对“当前展示”的某一条配对计算预言机标记：
  // forced = 每个最优匹配中第 i 行都配 j；
  // alternatives = 最优解集合里第 i 行出现过的不同列中，除 j 外的个数。
  const flagsFor = (assignment) =>
    assignment.map((j, i) => {
      const cols = new Set(optimalAssignments.map((p) => p[i]));
      return { forced: cols.size === 1 && cols.has(j), alternatives: cols.size - 1 };
    });

  return { totalCost, optimalAssignments, flagsFor };
}

// 可复现的伪随机数（mulberry32），让随机测试与性能测试可重复。
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function randomCostMatrix(n, rng, { forbiddenRate = 0, maxCost = 99 } = {}) {
  return Array.from({ length: n }, () =>
    Array.from({ length: n }, () =>
      rng() < forbiddenRate ? null : Math.floor(rng() * (maxCost + 1))
    )
  );
}
