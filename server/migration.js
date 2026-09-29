// 迁移求解：校准成本更新后，在“不增加最低总代价”的前提下，
// 尽量少改动上一批已核准的探针接线（reference 旧配对）。
//
// 两级目标严格分两次求解，**不用任何放大系数合并权重**
// （如 cost*B + change：B 必须大于第二级目标的最大跨度 n，
//   而代价上界 1e12 × 400 已接近 2^53，放大后可能越过安全整数范围）：
//
//   第一级：对新矩阵跑一次匈牙利，得到最小总代价 totalCost* 与终态势函数 u/v。
//     互补松弛定理：一个完美匹配达到 totalCost*，当且仅当它全部由“紧边”
//     （松弛 a[i][j]-u[i]-v[j] 恰为 0 的允许边）组成。
//   第二级：只在紧边子图内构造 0/1 权矩阵——
//     与参考同列（保留旧接线）记 0，换列（变更行）记 1，非紧边/禁配记 Infinity，
//     再跑一次匈牙利求权和最小的紧边完美匹配。该匹配仍是新矩阵的最优完美匹配
//     （第一级目标不增加），且变更行数达到全部同成本最优匹配中的最小值。
//
// 第二级矩阵只有 0 / 1 / Infinity，运算规模 O(n) ≪ 2^53，天然安全整数；
// totalCost 始终从原始整数矩阵直接复算，与两次求解的中间值无关。
//
// 参考配对即使在新矩阵中已是禁配边也照常参与变更计数：该行不可能保留旧列，
// 必然计入 changedRows；reference 的规模/排列/字段合法性由 validation 提前整批拒绝。

import { hungarianDetailed } from './hungarian.js';
import { analyzeTightMatching } from './mandatory.js';

/**
 * 两级目标迁移求解。
 * @param {ReadonlyArray<ReadonlyArray<number | null>>} costs 新成本矩阵 n×n
 * @param {number[]} reference 旧接线参考：reference[i] 为第 i 行原配对列（0 基排列）
 * @returns {{
 *   assignment: number[],
 *   totalCost: number,
 *   pairFlags: Array<{ forced: boolean, alternatives: number }>,
 *   changedRows: number[],
 *   changedCount: number,
 * }}
 *   assignment/totalCost/pairFlags 针对新矩阵本次展示配对（标记为重新分析，非沿用旧结论）；
 *   changedRows 为相对 reference 发生换列的行下标（0 基，升序）；changedCount 为其行数。
 * @throws {import('./hungarian.js').NoPerfectAssignmentError} 新矩阵不存在完美匹配
 */
export function solveMigration(costs, reference) {
  const n = costs.length;

  // 第一级：新矩阵的最小权完美匹配 + 终态势函数。
  const { totalCost, u, v } = hungarianDetailed(costs);

  // 第二级：紧边子图上的 0/1 权矩阵。
  // 保留参考列（紧且等于 reference[i]）= 0；其他紧边 = 1；非紧边/禁配 = Infinity。
  const changeCosts = new Array(n);
  for (let i = 0; i < n; i++) {
    const row = new Array(n).fill(null);
    const ui = u[i];
    const src = costs[i];
    for (let j = 0; j < n; j++) {
      const c = src[j];
      if (c === null) continue; // 禁配边：新矩阵不允许（参考边若落此格只计变更、不可选）
      if (c - ui - v[j] === 0) {
        row[j] = j === reference[i] ? 0 : 1;
      }
    }
    changeCosts[i] = row;
  }

  // 第一级已证明紧边子图至少含一个完美匹配（求解器返回的那个），
  // 故此处理论上不会抛 NoPerfectAssignmentError；一旦发生属于算法内部不变量被破坏。
  const { assignment: migrated } = hungarianDetailed(changeCosts);
  const assignment = Array.from(migrated);

  // 从原始整数矩阵精确复算总代价（不依赖第二级的 0/1 权和，也不依赖势函数）。
  let recomputedCost = 0;
  const changedRows = [];
  for (let i = 0; i < n; i++) {
    const j = assignment[i];
    recomputedCost += costs[i][j];
    if (j !== reference[i]) changedRows.push(i); // 参考边已禁配时自然落在其中
  }

  // 必然连线分析针对“新展示配对”用原势函数重新做，不沿用任何旧方案的标记。
  const { pairFlags } = analyzeTightMatching(costs, assignment, u, v);

  return {
    assignment,
    totalCost: recomputedCost,
    pairFlags,
    changedRows,
    changedCount: changedRows.length,
  };
}
