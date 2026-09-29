// 必然连线分析：在求出最小总代价后，判断“当前展示的每条配对”是否出现在
// 所有同价（最优）完美匹配中，并给出该探针在最优解里还能选的可替换连线数。
//
// 原理（不枚举任何排列，整体仍为 O(n²)~O(n³)）：
//   匈牙利终态势函数 u/v 满足 允许边 a[i][j]-u[i]-v[j] >= 0，配对边上恰为 0。
//   1. 等势子图（紧边子图）= 所有松弛恰为 0 的允许边；
//      一个完美匹配最优 当且仅当 它全部由紧边组成。
//   2. 构造有向“交错图”D：配对边 j→i（列指向其匹配行），
//      非配对紧边 i→j（行指向可替换的列）。
//   3. 配对边 (i,j) 能被某个最优匹配替换 当且仅当 D 中存在经过它的有向环，
//      即行节点 i 与列节点 j 属于同一个强连通分量（SCC）。
//      不在同一 SCC 时，该边出现在每一个最优完美匹配中，即“必然连线”。
//   4. 可替换连线数 = 与行 i 同 SCC 内、由 i 出发的非配对紧边数量
//      （环上 i 可直接改选的不同列；配对列本身不计）。
//
// 禁配边（Infinity/null）不构成紧边；零代价与重复代价天然由紧边相等性处理。
// 全程整数势函数、整数松弛，与求解器共用同一精确数值上界（< 2^53）。

import { hungarianDetailed, NoPerfectAssignmentError } from './hungarian.js';

/**
 * 求最优匹配并分析当前配对在所有最优完美匹配中的必然性。
 * @param {ReadonlyArray<ReadonlyArray<number | null>>} costs n×n，元素为 null 或非负整数
 * @returns {{
 *   assignment: number[],
 *   totalCost: number,
 *   pairFlags: Array<{ forced: boolean, alternatives: number }>,
 * }}
 *   pairFlags[i] 对应展示配对 (i, assignment[i])：
 *   forced=true 表示该连线出现在每一个最优完美匹配中；
 *   alternatives 为该探针在最优解中可改配的其他列数量（必然时为 0）。
 * @throws {NoPerfectAssignmentError} 不存在覆盖全部行列的完美匹配
 */
export function analyzeMandatoryPairs(costs) {
  const n = costs.length;
  const { assignment, totalCost, u, v } = hungarianDetailed(costs);

  // 节点编号：0..n-1 为行（探针），n..2n-1 为列（测试座）。
  const ROW = 2 * n;
  const colNode = (j) => n + j;

  // 行节点的出边（非配对紧边），同时记录每一行的全部紧边列，
  // 供在所属 SCC 内统计可替换连线。
  /** @type {number[][]} */
  const rowTightCols = new Array(n);
  /** @type {number[][]} */
  const adj = new Array(ROW);
  for (let i = 0; i < n; i++) {
    adj[i] = [];
    const tight = [];
    const ui = u[i];
    const src = costs[i];
    for (let j = 0; j < n; j++) {
      const c = src[j];
      if (c === null) continue; // 禁配边永不紧
      // 紧边判定用精确相等；势函数与代价均为整数，差在 2^53 内精确。
      if (c - ui - v[j] === 0) tight.push(j);
    }
    rowTightCols[i] = tight;
  }
  // 列节点出边：仅一条配对边 j → 匹配行。
  for (let j = 0; j < n; j++) adj[n + j] = [];
  for (let i = 0; i < n; i++) {
    const j = assignment[i];
    for (const cj of rowTightCols[i]) {
      if (cj !== j) adj[i].push(colNode(cj)); // 非配对紧边：行 → 列
    }
    adj[colNode(j)].push(i); // 配对边：列 → 行
  }

  // Tarjan 强连通分量（迭代式 DFS，避免任何递归深度假设）。
  const comp = tarjanSCC(adj, ROW);

  const pairFlags = new Array(n);
  for (let i = 0; i < n; i++) {
    const j = assignment[i];
    const forced = comp[i] !== comp[n + j];
    let alternatives = 0;
    if (!forced) {
      const ci = comp[i];
      for (const cj of rowTightCols[i]) {
        if (cj !== j && comp[n + cj] === ci) alternatives++;
      }
    }
    pairFlags[i] = { forced, alternatives };
  }

  return { assignment, totalCost, pairFlags };
}

// 迭代式 Tarjan：返回每个节点所属 SCC 编号（编号顺序为逆拓扑，仅需相等关系）。
function tarjanSCC(adj, nodeCount) {
  const index = new Int32Array(nodeCount).fill(-1);
  const low = new Int32Array(nodeCount);
  const onStack = new Uint8Array(nodeCount);
  const stack = new Int32Array(nodeCount);
  let stackTop = 0;
  const comp = new Int32Array(nodeCount).fill(-1);
  let nextIndex = 0;
  let compCount = 0;

  // 每条 DFS 栈帧记录 [节点, 下一条待遍历出边下标]。
  const callNode = new Int32Array(nodeCount);
  const callEdge = new Int32Array(nodeCount);

  for (let root = 0; root < nodeCount; root++) {
    if (index[root] !== -1) continue;
    let depth = 0;
    callNode[0] = root;
    callEdge[0] = 0;
    index[root] = nextIndex;
    low[root] = nextIndex;
    nextIndex++;
    stack[stackTop++] = root;
    onStack[root] = 1;

    while (depth >= 0) {
      const x = callNode[depth];
      const edges = adj[x];
      if (callEdge[depth] < edges.length) {
        const y = edges[callEdge[depth]++];
        if (index[y] === -1) {
          depth++;
          callNode[depth] = y;
          callEdge[depth] = 0;
          index[y] = nextIndex;
          low[y] = nextIndex;
          nextIndex++;
          stack[stackTop++] = y;
          onStack[y] = 1;
        } else if (onStack[y]) {
          if (index[y] < low[x]) low[x] = index[y];
        }
      } else {
        if (low[x] === index[x]) {
          while (true) {
            const w = stack[--stackTop];
            onStack[w] = 0;
            comp[w] = compCount;
            if (w === x) break;
          }
          compCount++;
        }
        depth--;
        if (depth >= 0) {
          const parent = callNode[depth];
          if (low[x] < low[parent]) low[parent] = low[x];
        }
      }
    }
  }

  return comp;
}

export { NoPerfectAssignmentError };
