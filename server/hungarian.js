// 最小权完美二分匹配（匈牙利算法），O(n^3)
// 行=探针，列=测试座；null/Infinity 表示禁配。
// 不枚举任何排列：每轮沿等势交错树做一次增广，共 n 轮，每轮 O(n^2)。
// 所有数值均为整数浮点（最大总代价 4e14 < 2^53），运算结果精确。

export class NoPerfectAssignmentError extends Error {
  constructor() {
    super('NO_PERFECT_ASSIGNMENT');
    this.code = 'NO_PERFECT_ASSIGNMENT';
  }
}

/**
 * 内部版本：除最优分配与总代价外，还返回终态行/列势函数 u、v。
 * 势函数满足：允许边 a[i][j]-u[i]-v[j] >= 0，配对边上恰为 0；
 * 供“必然连线”分析构造等势子图使用，求解过程与对外版本完全一致。
 * @param {ReadonlyArray<ReadonlyArray<number | null>>} costs n×n，元素为 null 或 [0,1e12] 整数
 * @returns {{ assignment: number[], totalCost: number, u: number[], v: number[] }}
 *   assignment[i] 表示第 i 行探针匹配的列；totalCost 为精确整数总和；
 *   u/v 为 0 基终态势函数（仅 0..n-1 有效）
 * @throws {NoPerfectAssignmentError} 不存在覆盖全部行列的完美匹配
 */
export function hungarianDetailed(costs) {
  const n = costs.length;

  // 转为 1..n 下标的稠密代价矩阵。
  // 注意：Float64Array 尾随元素默认是 0，必须显式 .fill(Infinity)，
  // 否则禁配格会被误当成代价 0 的合法边。
  const a = new Array(n + 1);
  a[0] = new Float64Array(n + 1).fill(Infinity);
  for (let i = 1; i <= n; i++) {
    const src = costs[i - 1];
    const row = new Float64Array(n + 1).fill(Infinity); // 下标 0 与所有禁配格保持 Infinity
    for (let j = 1; j <= n; j++) {
      const v = src[j - 1];
      if (v !== null) row[j] = v;
    }
    a[i] = row;
  }

  // u[i]/v[j]：行/列势函数，恒有 a[i][j]-u[i]-v[j] >= 0（允许边）。
  const u = new Float64Array(n + 1);
  const v = new Float64Array(n + 1);
  // p[j]：列 j 当前匹配的行，0 表示自由列；way[j]：交错树上到达列 j 的前驱列（根为虚拟列 0）。
  const p = new Int32Array(n + 1);
  const way = new Int32Array(n + 1);

  for (let i = 1; i <= n; i++) {
    p[0] = i; // 虚拟列 0 挂在当前待匹配行上
    const minv = new Float64Array(n + 1).fill(Infinity); // 各列到交错树的最小松弛
    const used = new Uint8Array(n + 1);
    let j0 = 0;

    do {
      used[j0] = 1;
      const i0 = p[j0];
      const ai0 = a[i0];
      const ui0 = u[i0];
      let delta = Infinity;
      let j1 = 0;

      // 用新加入树的行 i0 更新所有未访问列的最小松弛。
      for (let j = 1; j <= n; j++) {
        if (used[j] === 0) {
          const c = ai0[j];
          // 禁配边：c=Infinity，cur=Infinity，永不更新 minv。
          const cur = c - ui0 - v[j];
          if (cur < minv[j]) {
            minv[j] = cur;
            way[j] = j0; // 前驱列：当前行 i0=p[j0] 挂在列 j0 上
          }
          if (minv[j] < delta) {
            delta = minv[j];
            j1 = j;
          }
        }
      }

      // 没有任何可到达的未访问列（minv 全为 Infinity）：
      // 增广树无法再扩展，剩余自由列不可达，违反 Hall 条件。
      if (delta === Infinity) {
        throw new NoPerfectAssignmentError();
      }

      // 调整势函数：树内行列平移 delta，树外列（含虚拟列 0）的松弛同步减去 delta。
      // j 必须从 0 开始：j0=0 已在树内更新 u/v；minv[0] 随后会被 delta 归零，
      // 保证下次 min 选择正常进行（minv[0] 从不参与实际扩展，因 used[0]=1）。
      for (let j = 0; j <= n; j++) {
        if (used[j] === 1) {
          u[p[j]] += delta;
          v[j] -= delta;
        } else {
          minv[j] -= delta;
        }
      }

      j0 = j1;
    } while (p[j0] !== 0); // 到达自由列则找到增广路

    // 沿 way 回溯增广，翻转匹配边。
    do {
      const j1 = way[j0];
      p[j0] = p[j1];
      j0 = j1;
    } while (j0 !== 0);
  }

  // p[j] => 行到列的映射；直接从原始整数矩阵复算总和，保证精确可核验。
  const assignment = new Int32Array(n);
  let totalCost = 0;
  for (let j = 1; j <= n; j++) {
    const i = p[j];
    if (i === 0) throw new NoPerfectAssignmentError();
    const c = costs[i - 1][j - 1];
    if (c === null || c === undefined) throw new NoPerfectAssignmentError();
    assignment[i - 1] = j - 1;
    totalCost += c;
  }

  // 丢弃虚拟下标 0，只返回 0 基势函数。
  return {
    assignment: Array.from(assignment),
    totalCost,
    u: Array.from(u.subarray(1)),
    v: Array.from(v.subarray(1)),
  };
}

/**
 * @param {ReadonlyArray<ReadonlyArray<number | null>>} costs n×n，元素为 null 或 [0,1e12] 整数
 * @returns {{ assignment: number[], totalCost: number }}
 *   assignment[i] 表示第 i 行探针匹配的列；totalCost 为精确整数总和
 * @throws {NoPerfectAssignmentError} 不存在覆盖全部行列的完美匹配
 */
export function hungarian(costs) {
  const { assignment, totalCost } = hungarianDetailed(costs);
  return { assignment, totalCost };
}
