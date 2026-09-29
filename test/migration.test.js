import { describe, it, expect } from 'vitest';
import { solveMigration } from '../server/migration.js';
import { NoPerfectAssignmentError } from '../server/hungarian.js';
import {
  bruteForceMigration,
  bruteForceOptimalSet,
  mulberry32,
  randomCostMatrix,
} from './helpers.js';

const MAX_COST = 1_000_000_000_000;

// 断言迁移结果：新配对是“变更数最小的同成本最优匹配”，总价精确、标记与穷举一致。
function expectMigrationOptimal(costs, reference, result) {
  const oracle = bruteForceMigration(costs, reference);
  expect(oracle).not.toBeNull();
  const n = costs.length;

  // 结构：合法完美匹配且不命中禁配
  expect(result.assignment).toHaveLength(n);
  const used = new Set();
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const j = result.assignment[i];
    expect(Number.isInteger(j)).toBe(true);
    expect(j).toBeGreaterThanOrEqual(0);
    expect(j).toBeLessThan(n);
    expect(used.has(j)).toBe(false);
    used.add(j);
    expect(costs[i][j]).not.toBeNull();
    sum += costs[i][j];
  }

  // 第一级目标：精确最小总成本
  expect(sum).toBe(result.totalCost);
  expect(result.totalCost).toBe(oracle.totalCost);

  // 第二级目标：展示配对属于“最少变更”的同成本最优集合
  const changed = result.assignment.reduce((acc, j, i) => acc + (j !== reference[i] ? 1 : 0), 0);
  expect(changed).toBe(oracle.minChanged);
  const shownIsLeastChanged = oracle.leastChangedAssignments.some((p) =>
    p.every((j, i) => j === result.assignment[i])
  );
  expect(shownIsLeastChanged).toBe(true);

  // changedRows 与 assignment/reference 完全对应、升序
  const expectedRows = result.assignment
    .map((j, i) => (j !== reference[i] ? i : -1))
    .filter((i) => i >= 0);
  expect(result.changedRows).toEqual(expectedRows);
  expect(result.changedCount).toBe(expectedRows.length);

  // 必然标记：针对新展示配对、基于新矩阵全部同成本最优集合重新分析
  expect(result.pairFlags).toHaveLength(n);
  const expectedFlags = oracle.flagsFor(result.assignment);
  expect(result.pairFlags).toEqual(expectedFlags);
}

// 随机参考排列（保证规模/排列合法；可能引用禁配边——这是允许的）。
function randomReference(n, rng) {
  const ref = Array.from({ length: n }, (_, i) => i);
  for (let i = n - 1; i > 0; i--) {
    const k = Math.floor(rng() * (i + 1));
    [ref[i], ref[k]] = [ref[k], ref[i]];
  }
  return ref;
}

describe('迁移求解：小矩阵穷举核对两级目标', () => {
  const cases = [
    { n: 1, trials: 30 },
    { n: 2, trials: 60 },
    { n: 3, trials: 60 },
    { n: 4, trials: 40 },
    { n: 5, trials: 24 },
    { n: 6, trials: 10 },
    { n: 7, trials: 4 },
  ];

  for (const { n, trials } of cases) {
    for (let t = 0; t < trials; t++) {
      const mode = t % 4;
      const rng = mulberry32(4242 * n + t * 97 + 3);
      const costs = randomCostMatrix(n, rng, {
        forbiddenRate: mode === 0 ? 0 : mode === 1 ? 0.2 : mode === 2 ? 0.45 : 0.6,
        maxCost: mode === 3 ? 2 : mode === 2 ? 5 : 100, // 小代价制造大量同价并列
      });
      const reference = randomReference(n, rng);

      it(`n=${n} trial=${t} mode=${mode}：先最小成本再最少变更，与穷举一致`, () => {
        if (bruteForceOptimalSet(costs) === null) {
          expect(() => solveMigration(costs, reference)).toThrow(NoPerfectAssignmentError);
          return;
        }
        const result = solveMigration(costs, reference);
        expectMigrationOptimal(costs, reference, result);
      });
    }
  }
});

describe('迁移求解：禁配与参考边失效', () => {
  it('参考边在新矩阵已禁配：仍可计变更数，且结果最优', () => {
    const costs = [
      [null, 5],
      [5, 5],
    ];
    const reference = [0, 1]; // 参考 (0,0) 已禁配
    const result = solveMigration(costs, reference);
    expect(result.assignment).toEqual([1, 0]);
    expect(result.totalCost).toBe(10);
    expect(result.changedRows).toEqual([0, 1]);
    expect(result.changedCount).toBe(2);
    // 唯一可行最优：新配对全部必然（不沿用参考的“旧结论”）
    expect(result.pairFlags.every((f) => f.forced && f.alternatives === 0)).toBe(true);
  });

  it('部分参考边禁配：被禁行必然变更，其余可保留行确实保留', () => {
    // 参考 [0,1,2]，其中参考边 (0,0) 在新矩阵已禁配。
    // 最优匹配 [1,0,2]（总价 14）：行0、行1 变更，行2 保留参考列2。
    const costs = [
      [null, 4, 4],
      [5, 5, null],
      [5, 5, 5],
    ];
    const reference = [0, 1, 2];
    const result = solveMigration(costs, reference);
    expect(result.totalCost).toBe(14);
    // 最优集合中相对参考最少变更为 2 行（行0必离列0；行2随之让列）
    expect(result.changedCount).toBe(2);
    expect(result.assignment[2]).toBe(0);
    expectMigrationOptimal(costs, reference, result);
  });

  it('无完美匹配：迁移同样抛 NoPerfectAssignmentError，不返回任何配对', () => {
    const costs = [
      [5, null, null],
      [2, null, null],
      [7, 1, 3],
    ];
    expect(() => solveMigration(costs, [0, 1, 2])).toThrow(NoPerfectAssignmentError);
  });
});

describe('迁移求解：并列解中选择最少变更', () => {
  it('2×2 全同价：参考是最优时零变更', () => {
    const costs = [
      [5, 5],
      [5, 5],
    ];
    for (const reference of [
      [0, 1],
      [1, 0],
    ]) {
      const result = solveMigration(costs, reference);
      expect(result.totalCost).toBe(10);
      expect(result.assignment).toEqual(reference);
      expect(result.changedRows).toEqual([]);
      expect(result.changedCount).toBe(0);
    }
  });

  it('参考不在同成本最优集合：返回最接近参考的最优（穷举核对）', () => {
    // 唯一最优为交叉分配；参考为恒等分配（成本 101，非最优）
    const costs = [
      [1, 20],
      [20, 100],
    ];
    const reference = [0, 1];
    const result = solveMigration(costs, reference);
    expect(result.assignment).toEqual([1, 0]);
    expect(result.totalCost).toBe(40);
    expect(result.changedRows).toEqual([0, 1]);
  });

  it('断开的同价块：块内优先贴合参考，块间互不影响', () => {
    const costs = [
      [1, 1, null, null],
      [1, 1, null, null],
      [null, null, 2, 2],
      [null, null, 2, 2],
    ];
    // 参考：左上块交叉（2 变更），右下块保持（0 变更）→ 迁移后恰好只改左上块回参考？
    // 参考本身可行时零变更最优；此处参考 [1,0,2,3] 即一个最优，应零变更保留。
    const reference = [1, 0, 2, 3];
    const result = solveMigration(costs, reference);
    expect(result.assignment).toEqual(reference);
    expect(result.changedCount).toBe(0);
    expect(result.totalCost).toBe(6);

    // 参考左上取交叉、右下也交叉：迁移在两个块内都能零变更
    const reference2 = [1, 0, 3, 2];
    const result2 = solveMigration(costs, reference2);
    expect(result2.assignment).toEqual(reference2);
    expect(result2.changedCount).toBe(0);
  });

  it('只改一个成本制造新最优：最小变更的最优匹配保留尽可能多旧线', () => {
    // 恒等分配与一个交换并列最优时，参考恒等分配 → 零变更
    const costs = [
      [0, 0, 9],
      [0, 0, 9],
      [9, 9, 0],
    ];
    const reference = [0, 1, 2];
    const result = solveMigration(costs, reference);
    expect(result.assignment).toEqual([0, 1, 2]);
    expect(result.changedCount).toBe(0);
    // 行2 的连线在所有最优中都必然；前两行可替换
    expect(result.pairFlags[2]).toEqual({ forced: true, alternatives: 0 });
    expect(result.pairFlags[0].forced).toBe(false);
  });

  it('成本变化打破平局：不得为保留旧线而增加总代价（第一级优先）', () => {
    // 旧矩阵全 5（恒等与交叉同价）；新矩阵使恒等分配更贵，交叉严格最优
    const costs = [
      [5, 5],
      [5, 6],
    ];
    // 恒等=11，交叉=10；即使参考恒等，也必须返回交叉（变更2行）而非贵 1 的保留
    const result = solveMigration(costs, [0, 1]);
    expect(result.totalCost).toBe(10);
    expect(result.assignment).toEqual([1, 0]);
    expect(result.changedCount).toBe(2);
  });
});

describe('迁移求解：精度与不合并权重', () => {
  it('1e12 量级：两级目标均精确，总代价为安全整数（n=5 穷举核对）', () => {
    const rng = mulberry32(31337);
    for (let t = 0; t < 30; t++) {
      const n = 1 + Math.floor(rng() * 5);
      const costs = randomCostMatrix(n, rng, { forbiddenRate: 0.2, maxCost: MAX_COST });
      const reference = randomReference(n, rng);
      if (bruteForceOptimalSet(costs) === null) continue;
      const result = solveMigration(costs, reference);
      expect(Number.isSafeInteger(result.totalCost)).toBe(true);
      expectMigrationOptimal(costs, reference, result);
    }
  });

  it('n=400、全部 1e12 量级：两次匈牙利仍快速且精确，不使用放大系数', () => {
    const n = 400;
    const rng = mulberry32(987654);
    const costs = Array.from({ length: n }, () =>
      Array.from({ length: n }, () => Math.floor(rng() * MAX_COST))
    );
    const reference = randomReference(n, rng);
    const started = performance.now();
    const result = solveMigration(costs, reference);
    const elapsed = performance.now() - started;
    expect(elapsed).toBeLessThan(3000);
    expect(result.assignment).toHaveLength(n);
    expect(result.pairFlags).toHaveLength(n);
    let sum = 0;
    for (let i = 0; i < n; i++) sum += costs[i][result.assignment[i]];
    expect(sum).toBe(result.totalCost);
    expect(Number.isSafeInteger(result.totalCost)).toBe(true);
    expect(result.changedCount).toBe(result.changedRows.length);
    // 供控制台留痕
    // eslint-disable-next-line no-console
    console.log(`n=${n} 迁移求解耗时 ${Math.round(elapsed)} ms，变更 ${result.changedCount} 行`);
  });

  it('零代价矩阵：任何参考都零变更（参考本身就是零成本最优）', () => {
    for (const n of [1, 2, 3, 4]) {
      const costs = Array.from({ length: n }, () => Array(n).fill(0));
      const reference = randomReference(n, mulberry32(n * 11 + 5));
      const result = solveMigration(costs, reference);
      expect(result.totalCost).toBe(0);
      expect(result.assignment).toEqual(reference);
      expect(result.changedCount).toBe(0);
    }
  });
});
