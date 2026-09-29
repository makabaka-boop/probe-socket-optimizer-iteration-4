import { describe, it, expect } from 'vitest';
import { analyzeMandatoryPairs, NoPerfectAssignmentError } from '../server/mandatory.js';
import { hungarian } from '../server/hungarian.js';
import { bruteForceOptimalSet, mulberry32, randomCostMatrix } from './helpers.js';

// 用穷举预言机逐行核对“当前展示配对”的 forced / alternatives，
// 并确认展示配对本身属于同价最优集合、总价不变。
function expectFlagsMatchOracle(costs, result) {
  const oracle = bruteForceOptimalSet(costs);
  expect(oracle).not.toBeNull();
  expect(result.totalCost).toBe(oracle.totalCost);
  // 展示配对必须真的是某个最优匹配
  const shownIsOptimal = oracle.optimalAssignments.some((p) =>
    p.every((j, i) => j === result.assignment[i])
  );
  expect(shownIsOptimal).toBe(true);

  expect(result.pairFlags).toHaveLength(result.assignment.length);
  const expected = oracle.flagsFor(result.assignment);
  result.pairFlags.forEach((flag, i) => {
    expect(typeof flag.forced).toBe('boolean'); // 稳定布尔标记
    expect(Number.isInteger(flag.alternatives)).toBe(true);
    expect(flag.alternatives).toBeGreaterThanOrEqual(0);
    // forced 与 alternatives 数量自洽：必然 ⇔ 可替换连线数为 0
    expect(flag.forced).toBe(flag.alternatives === 0);
    expect(flag.forced).toBe(expected[i].forced);
    expect(flag.alternatives).toBe(expected[i].alternatives);
  });
}

describe('必然连线：独立穷举预言机随机核对', () => {
  // 小 n、多轮、高同价概率（maxCost 很小）以制造大量同价最优；
  // 同时覆盖稠密、含禁配、近断开图。
  const cases = [
    { n: 1, trials: 30 },
    { n: 2, trials: 60 },
    { n: 3, trials: 60 },
    { n: 4, trials: 40 },
    { n: 5, trials: 20 },
    { n: 6, trials: 10 },
    { n: 7, trials: 5 },
  ];

  for (const { n, trials } of cases) {
    for (let t = 0; t < trials; t++) {
      const mode = t % 4;
      const rng = mulberry32(7777 * n + t * 131 + 7);
      const costs = randomCostMatrix(n, rng, {
        forbiddenRate: mode === 0 ? 0 : mode === 1 ? 0.25 : mode === 2 ? 0.45 : 0.6,
        maxCost: mode === 3 ? 3 : mode === 2 ? 8 : 100,
      });

      it(`n=${n} trial=${t} mode=${mode}：标记与穷举最优集合一致`, () => {
        let result;
        try {
          result = analyzeMandatoryPairs(costs);
        } catch (err) {
          expect(err).toBeInstanceOf(NoPerfectAssignmentError);
          expect(bruteForceOptimalSet(costs)).toBeNull();
          return;
        }
        expectFlagsMatchOracle(costs, result);
      });
    }
  }
});

describe('必然连线：唯一最优 / 多个同价最优 / 断开图', () => {
  it('n=1：唯一格子必然', () => {
    const result = analyzeMandatoryPairs([[42]]);
    expect(result.assignment).toEqual([0]);
    expect(result.totalCost).toBe(42);
    expect(result.pairFlags).toEqual([{ forced: true, alternatives: 0 }]);
  });

  it('唯一可行排列（其余全禁配）：每条连线必然', () => {
    const n = 4;
    const costs = Array.from({ length: n }, () => Array(n).fill(null));
    const target = [2, 0, 3, 1];
    for (let i = 0; i < n; i++) costs[i][target[i]] = (i + 1) * 10;
    const result = analyzeMandatoryPairs(costs);
    expect(result.assignment).toEqual(target);
    expect(result.totalCost).toBe(100);
    expect(result.pairFlags.every((f) => f.forced && f.alternatives === 0)).toBe(true);
  });

  it('严格唯一最优（虽然可行匹配很多）：全部必然', () => {
    const costs = [
      [1, 20, 30],
      [20, 2, 30],
      [30, 30, 3],
    ];
    const result = analyzeMandatoryPairs(costs);
    expect(result.assignment).toEqual([0, 1, 2]);
    expect(result.totalCost).toBe(6);
    expectFlagsMatchOracle(costs, result);
    expect(result.pairFlags.every((f) => f.forced)).toBe(true);
  });

  it('全零矩阵：所有 n! 个排列同价最优，每条配对都可替换且可替换数为 n-1', () => {
    for (const n of [1, 2, 3, 4]) {
      const costs = Array.from({ length: n }, () => Array(n).fill(0));
      const result = analyzeMandatoryPairs(costs);
      expect(result.totalCost).toBe(0);
      for (let i = 0; i < n; i++) {
        expect(result.pairFlags[i].forced).toBe(n === 1);
        expect(result.pairFlags[i].alternatives).toBe(n - 1);
      }
    }
  });

  it('重复代价导致多个同价最优：n=2 平局，两条配对都可替换且各 1 条替换', () => {
    const costs = [
      [5, 5],
      [5, 5],
    ];
    const result = analyzeMandatoryPairs(costs);
    expect(result.totalCost).toBe(10);
    expect(result.pairFlags).toEqual([
      { forced: false, alternatives: 1 },
      { forced: false, alternatives: 1 },
    ]);
  });

  it('零价与重复代价混合：标记仍精确（预言机核对）', () => {
    const costs = [
      [0, 0, 7],
      [0, 0, 7],
      [9, 9, 0],
    ];
    const result = analyzeMandatoryPairs(costs);
    expectFlagsMatchOracle(costs, result);
    // 行 2 以 0 代价占列 2 是严格必然；前两行在列 0/1 同价互换
    const i2 = result.assignment.indexOf(2);
    expect(result.pairFlags[i2].forced).toBe(true);
  });

  it('断开图（两个同价 2×2 块）：块内可替换（各 1 条），块间不可替换', () => {
    const costs = [
      [1, 1, null, null],
      [1, 1, null, null],
      [null, null, 2, 2],
      [null, null, 2, 2],
    ];
    const result = analyzeMandatoryPairs(costs);
    expect(result.totalCost).toBe(6);
    expect(result.pairFlags.every((f) => !f.forced && f.alternatives === 1)).toBe(true);
    expectFlagsMatchOracle(costs, result);
  });

  it('断开图但块内严格最优：块内也必然', () => {
    const costs = [
      [1, 9, null, null],
      [9, 1, null, null],
      [null, null, 2, 9],
      [null, null, 9, 2],
    ];
    const result = analyzeMandatoryPairs(costs);
    expect(result.pairFlags.every((f) => f.forced)).toBe(true);
    expectFlagsMatchOracle(costs, result);
  });

  it('禁配造成的“被迫连线”与“局部灵活”并存', () => {
    // 行0只能配列0（禁配其余）；行1/2 在列1/2 上同价。
    const costs = [
      [3, null, null],
      [null, 5, 5],
      [null, 5, 5],
    ];
    const result = analyzeMandatoryPairs(costs);
    expect(result.assignment[0]).toBe(0);
    expect(result.pairFlags[0]).toEqual({ forced: true, alternatives: 0 });
    for (const i of [1, 2]) {
      expect(result.pairFlags[i].forced).toBe(false);
      expect(result.pairFlags[i].alternatives).toBe(1);
    }
    expectFlagsMatchOracle(costs, result);
  });

  it('无完美匹配（违反 Hall）：分析抛出，不返回任何标记', () => {
    const costs = [
      [5, null, null],
      [2, null, null],
      [7, 1, 3],
    ];
    expect(() => analyzeMandatoryPairs(costs)).toThrow(NoPerfectAssignmentError);
  });

  it('整行禁配：分析抛出', () => {
    const costs = [
      [1, 2],
      [null, null],
    ];
    expect(() => analyzeMandatoryPairs(costs)).toThrow(NoPerfectAssignmentError);
  });
});

describe('必然连线：不改变求解器价格与展示结论', () => {
  it('analyzeMandatoryPairs 的 assignment/totalCost 与原求解器完全一致', () => {
    const rng = mulberry32(20260923);
    for (let t = 0; t < 100; t++) {
      const n = 1 + Math.floor(rng() * 7);
      const costs = randomCostMatrix(n, rng, { forbiddenRate: rng() * 0.5, maxCost: 50 });
      let base;
      let baseThrew = false;
      try {
        base = hungarian(costs);
      } catch {
        baseThrew = true;
      }
      if (baseThrew) {
        expect(() => analyzeMandatoryPairs(costs)).toThrow(NoPerfectAssignmentError);
      } else {
        const analyzed = analyzeMandatoryPairs(costs);
        expect(analyzed.assignment).toEqual(base.assignment);
        expect(analyzed.totalCost).toBe(base.totalCost);
      }
    }
  });

  it('原求解器返回值不暴露势函数等算法内部中间态', () => {
    const result = hungarian([
      [1, 2],
      [3, 4],
    ]);
    expect(Object.keys(result).sort()).toEqual(['assignment', 'totalCost']);
    expect(result.u).toBeUndefined();
    expect(result.v).toBeUndefined();
  });

  it('分析结果只暴露稳定布尔与可替换数量，不含内部中间态', () => {
    const result = analyzeMandatoryPairs([
      [1, 1],
      [1, 1],
    ]);
    expect(Object.keys(result).sort()).toEqual(['assignment', 'pairFlags', 'totalCost']);
    for (const flag of result.pairFlags) {
      expect(Object.keys(flag).sort()).toEqual(['alternatives', 'forced']);
    }
  });

  it('n=400 稠密矩阵：分析开销可忽略（三秒预算内）', () => {
    const n = 400;
    const rng = mulberry32(31337);
    const costs = Array.from({ length: n }, () =>
      Array.from({ length: n }, () => Math.floor(rng() * 1_000_000))
    );
    const started = performance.now();
    const result = analyzeMandatoryPairs(costs);
    const elapsed = performance.now() - started;
    expect(result.pairFlags).toHaveLength(n);
    expect(elapsed).toBeLessThan(3000);
    // 稠密随机代价几乎必然每条都必然（碰撞概率极低），但以自洽性断言为主
    for (const f of result.pairFlags) {
      expect(f.forced).toBe(f.alternatives === 0);
    }
  });
});
