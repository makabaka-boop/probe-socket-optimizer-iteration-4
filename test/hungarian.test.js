import { describe, it, expect } from 'vitest';
import { hungarian, NoPerfectAssignmentError } from '../server/hungarian.js';
import { bruteForce, mulberry32, randomCostMatrix } from './helpers.js';

const MAX_COST = 1_000_000_000_000;

// 校验返回值确实是覆盖全部行、列各一次的完美匹配，并复算总和。
function expectValidPerfectMatching(costs, result) {
  const n = costs.length;
  expect(result.assignment).toHaveLength(n);
  const usedCols = new Set();
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const j = result.assignment[i];
    expect(Number.isInteger(j)).toBe(true);
    expect(j).toBeGreaterThanOrEqual(0);
    expect(j).toBeLessThan(n);
    expect(usedCols.has(j)).toBe(false); // 每列恰好使用一次
    usedCols.add(j);
    const c = costs[i][j];
    expect(c).not.toBeNull(); // 配对不能落在禁配格
    sum += c;
  }
  expect(usedCols.size).toBe(n);
  expect(sum).toBe(result.totalCost);
  return sum;
}

describe('匈牙利算法：随机小矩阵穷举核对', () => {
  // 对每个 n 用不同种子多轮生成稠密/稀疏矩阵，全部与 n! 穷举结果一致。
  const cases = [
    { n: 1, trials: 30 },
    { n: 2, trials: 30 },
    { n: 3, trials: 30 },
    { n: 4, trials: 20 },
    { n: 5, trials: 12 },
    { n: 6, trials: 6 },
    { n: 7, trials: 3 },
    { n: 8, trials: 2 },
  ];

  for (const { n, trials } of cases) {
    for (let t = 0; t < trials; t++) {
      const sparse = t % 2 === 1;
      const rng = mulberry32(1000 * n + t * 7 + 13);
      const costs = randomCostMatrix(n, rng, {
        forbiddenRate: sparse ? 0.25 : 0,
      });
      const expected = bruteForce(costs);

      it(`n=${n} trial=${t} ${sparse ? '含禁配' : '稠密'}，总代价与穷举一致`, () => {
        if (expected === null) {
          expect(() => hungarian(costs)).toThrow(NoPerfectAssignmentError);
        } else {
          const result = hungarian(costs);
          expectValidPerfectMatching(costs, result);
          expect(result.totalCost).toBe(expected.totalCost);
        }
      });
    }
  }

  it('全部禁配：n=1..6 均无解', () => {
    for (let n = 1; n <= 6; n++) {
      const costs = Array.from({ length: n }, () => Array(n).fill(null));
      expect(() => hungarian(costs)).toThrow(NoPerfectAssignmentError);
    }
  });

  it('唯一可行排列可被找到', () => {
    const n = 5;
    const costs = Array.from({ length: n }, () => Array(n).fill(null));
    const target = [3, 0, 4, 1, 2];
    for (let i = 0; i < n; i++) costs[i][target[i]] = (i + 1) * 10;
    const result = hungarian(costs);
    expect(result.assignment).toEqual(target);
    expect(result.totalCost).toBe(150);
  });
});

describe('匈牙利算法：违反 Hall 条件的无解矩阵', () => {
  it('单个孤立行（某行全部禁配）', () => {
    const costs = [
      [5, 1, null],
      [null, null, null],
      [2, 3, 4],
    ];
    expect(() => hungarian(costs)).toThrow(NoPerfectAssignmentError);
  });

  it('两行都只允许同一列（Hall 邻集不足）', () => {
    const costs = [
      [5, null, null],
      [2, null, null],
      [7, 1, 3],
    ];
    expect(() => hungarian(costs)).toThrow(NoPerfectAssignmentError);
  });

  it('三行的可选列都落在同一个两列子集里', () => {
    const costs = [
      [5, 1, null],
      [2, 4, null],
      [7, 3, null],
    ];
    expect(() => hungarian(costs)).toThrow(NoPerfectAssignmentError);
  });

  it('块对角禁配：左半行与右半列全部禁配（n=4）', () => {
    const costs = [
      [1, 2, null, null],
      [3, 4, null, null],
      [null, null, 5, 6],
      [null, null, 7, 8],
    ];
    // 这其实是有解的（两个 2×2 块），作为 Hall 判断的反向对照：
    const result = hungarian(costs);
    expectValidPerfectMatching(costs, result);
    expect(result.totalCost).toBe(bruteForce(costs).totalCost);
  });

  it('随机稀疏矩阵：算法结论与穷举结论一致（含 Hall 无解）', () => {
    const rng = mulberry32(424242);
    for (let t = 0; t < 200; t++) {
      const n = 1 + Math.floor(rng() * 6);
      const costs = randomCostMatrix(n, rng, { forbiddenRate: 0.35 });
      const expected = bruteForce(costs);
      if (expected === null) {
        expect(() => hungarian(costs)).toThrow(NoPerfectAssignmentError);
      } else {
        const result = hungarian(costs);
        expectValidPerfectMatching(costs, result);
        expect(result.totalCost).toBe(expected.totalCost);
      }
    }
  });
});

describe('匈牙利算法：贪心失效反例（证明必须精确求解）', () => {
  it('逐行取当前最小可用列的贪心不是最优，匈牙利给出全局最优', () => {
    // 行0贪心取列0(1)，行1只能取列1(100)，合计 101；
    // 全局最优是交叉分配 (0→1,1→0)=20+20=40。
    const costs = [
      [1, 20],
      [20, 100],
    ];
    const result = hungarian(costs);
    expect(result.totalCost).toBe(40);
    expect(result.totalCost).toBe(bruteForce(costs).totalCost);
  });

  it('顺序贪心在禁配下可能直接无解，而完美匹配实际存在', () => {
    // 行0唯一可行是列0；若贪心先给行1选列0，行0将“无解”。
    const costs = [
      [5, null],
      [6, 8],
    ];
    const result = hungarian(costs);
    expect(result.assignment).toEqual([0, 1]);
    expect(result.totalCost).toBe(13);
  });
});

describe('匈牙利算法：大数精度与边界', () => {
  it('零矩阵总代价为 0', () => {
    const costs = [
      [0, 0],
      [0, 0],
    ];
    const result = hungarian(costs);
    expect(result.totalCost).toBe(0);
    expectValidPerfectMatching(costs, result);
  });

  it('全部取最大代价 1e12：n=400 总代价 4e14，仍为精确整数', () => {
    const n = 400;
    const costs = Array.from({ length: n }, () => new Array(n).fill(MAX_COST));
    const result = hungarian(costs);
    expect(result.totalCost).toBe(MAX_COST * n);
    expect(Number.isSafeInteger(result.totalCost)).toBe(true);
  });

  it('1e12 量级混合 0，与穷举一致（n=5）', () => {
    const rng = mulberry32(909);
    const costs = randomCostMatrix(5, rng, { forbiddenRate: 0.2, maxCost: MAX_COST });
    const result = hungarian(costs);
    const expected = bruteForce(costs);
    if (expected === null) {
      expect(() => hungarian(costs)).toThrow(NoPerfectAssignmentError);
    } else {
      expect(result.totalCost).toBe(expected.totalCost);
      expect(Number.isSafeInteger(result.totalCost)).toBe(true);
    }
  });
});
