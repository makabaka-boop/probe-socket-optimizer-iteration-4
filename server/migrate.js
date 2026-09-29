// 迁移求解（两级字典序目标，不做任何加权合并）：
//   第一级：在新矩阵上最小化完美匹配的总代价（与 /api/solve 完全相同的匈牙利求解）；
//   第二级：在所有“同最小总代价”的完美匹配中，最小化相对旧接线参考的变更行数，
//           即最小化 #{ i : assignment[i] !== reference[i] }。
//
// 关键约束：禁止用「大系数 × 总成本 + 变更数」这类放大系数把两级目标压成一个标量——
// 代价上界 4e14 已接近 2^53，再乘系数会越过安全整数范围导致精度丢失。
// 因此这里顺序求解两次独立的匈牙利，两次权重都在安全整数范围内：
//   第 1 次权重 ∈ [0,1e12]，总代价上界 4e14（< 2^53）；
//   第 2 次权重只取 0/1，总和上界 n(≤400)。
//
// 第二级为什么只在紧边（等势）子图上求：
//   第一级终态势函数 u/v 满足允许边 a[i][j]-u[i]-v[j] >= 0、配对边上恰为 0。
//   一个完美匹配达到最小总代价，当且仅当它全部由紧边（松弛恰为 0 的允许边）组成。
//   故构造只保留紧边的二值矩阵：参考仍落在紧边上的格代价 0（该行可保留旧线），
//   其余紧边代价 1（该行必须变更），非紧边/禁配格置 null。在该子图上求最小权完美匹配，
//   得到的既是某个最优完美匹配（第一级目标不变），又把变更行数压到最小。
//
// 参考排列即使在新矩阵中命中禁配边也依然合法：该边不是允许边、永不紧，
// 第二级自然无法保留它，该行按“变更”计数；参考的结构合法性由 validation 整批把关。

import { hungarianDetailed, NoPerfectAssignmentError } from './hungarian.js';

/**
 * 两级目标迁移求解。
 * @param {ReadonlyArray<ReadonlyArray<number | null>>} costs 新矩阵 n×n，元素 null 或 [0,1e12] 整数
 * @param {ReadonlyArray<number>} reference 旧接线参考：长度 n 的 0..n-1 排列（允许边在新矩阵中已禁配）
 * @returns {{ assignment: number[], totalCost: number, changedRows: number }}
 *   assignment 为新配对（最小总代价且变更行最少）；totalCost 为按新矩阵复算的精确整数；
 *   changedRows 为 assignment 与 reference 逐行不同的行数
 * @throws {NoPerfectAssignmentError} 新矩阵禁配关系下不存在完美匹配
 */
export function migrateWithReference(costs, reference) {
  const n = costs.length;

  // 第一级：与旧接口相同的最小总代价求解，同时拿到终态势函数 u/v。
  const { assignment: tightAssignment, totalCost, u, v } = hungarianDetailed(costs);

  // 紧边子图的二值代价：参考可保留的紧边为 0，其他紧边为 1，非紧边/禁配为 null。
  const binary = new Array(n);
  for (let i = 0; i < n; i++) {
    const row = new Array(n).fill(null);
    const src = costs[i];
    const ui = u[i];
    const refJ = reference[i];
    for (let j = 0; j < n; j++) {
      const c = src[j];
      if (c === null) continue; // 禁配边永不紧（参考的旧线若已禁配，同样无法保留）
      if (c - ui - v[j] === 0) {
        row[j] = j === refJ ? 0 : 1;
      }
    }
    binary[i] = row;
  }

  // 第一级给出的 tightAssignment 全部由紧边组成，因此紧边子图必有完美匹配，
  // 这里只会在子图内部成功；其最小二值代价 = 最小变更行数。
  const { assignment } = hungarianDetailed(binary);

  // 直接对参考逐行复算变更数，不依赖二值矩阵的势函数/中间值。
  let changedRows = 0;
  for (let i = 0; i < n; i++) {
    if (assignment[i] !== reference[i]) changedRows++;
    // 防御性自检：返回配对必须落在新矩阵的允许格上。
    if (costs[i][assignment[i]] === null) throw new NoPerfectAssignmentError();
  }

  return { assignment, totalCost, changedRows };
}

export { NoPerfectAssignmentError };
