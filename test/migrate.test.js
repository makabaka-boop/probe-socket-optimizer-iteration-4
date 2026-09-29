import { describe, it, expect } from 'vitest';
import { migrateWithReference, NoPerfectAssignmentError } from '../server/migrate.js';
import { bruteForce, bruteForceMigrate, mulberry32, randomCostMatrix } from './helpers.js';
import { hungarian } from '../server/hungarian.js';

const MAX_COST = 1_000_000_000_000;

// 校验返回配对是新矩阵上的完美匹配，并独立复算总代价与变更行数。
function expectValidMigration(costs, reference, result) {
  const n = costs.length;
  expect(result.assignment).toHaveLength(n);
  const used = new Set();
  let sum = 0;
  let changed = 0;
  for (let i = 0; i < n; i++) {
    const j = result.assignment[i];
    expect(Number.isInteger(j)).toBe(true);
    expect(j).toBeGreaterThanOrEqual(0);
    expect(j).toBeLessThan(n);
    expect(used.has(j)).toBe(false);
    used.add(j);
    expect(costs[i][j]).not.toBeNull(); // 新配对不能落在禁配格
    sum += costs[i][j];
    if (j !== reference[i]) changed++;
  }
  expect(used.size).toBe(n);
  expect(sum).toBe(result.totalCost);
  expect(changed).toBe(result.changedRows);
  return { sum, changed };
}

// 与穷举预言机逐轮核对：最小总成本 + 同成本下最小变更，且结果是两级最优之一。
function expectMatchesOracle(costs, reference, result) {
  const oracle = bruteForceMigrate(costs, reference);
  expect(oracle).not.toBeNull();
  expect(result.totalCost).toBe(oracle.totalCost); // 第一级目标
  expect(result.changedRows).toBe(oracle.minChanged); // 第二级目标
  const isOneOfBest = oracle.optimalAssignments.some((p) =>
    p.every((j, i) => j === result.assignment[i])
  );
  expect(isOneOfBest).toBe(true);
}

describe('迁移两级目标：随机小矩阵 + 随机参考穷举核对', () => {
  // 小代价（制造大量同价并列）与高代价（逼近 4e14 上界，验证不用放大系数也精确）交替。
  const cases = [
    { n: 1, trials: 30 },
    { n: 2, trials: 80 },
    { n: 3, trials: 80 },
    { n: 4, trials: 50 },
    { n: 5, trials: 24 },
    { n: 6, trials: 12 },
    { n: 7, trials: 5 },
  ];

  function randomPermutation(n, rng) {
    const p = Array.from({ length: n }, (_, j) => j);
    for (let i = n - 1; i > 0; i--) {
      const k = Math.floor(rng() * (i + 1));
      [p[i], p[k]] = [p[k], p[i]];
    }
    return p;
  }

  for (const { n, trials } of cases) {
    for (let t = 0; t < trials; t++) {
      const mode = t % 4;
      const rng = mulberry32(5151 * n + t * 977 + 3);
      const costs = randomCostMatrix(n, rng, {
        forbiddenRate: mode === 0 ? 0 : mode === 1 ? 0.25 : mode === 2 ? 0.45 : 0.6,
        // 小代价制造并列；大代价验证两级目标在接近安全整数上界时仍精确（无放大系数）
        maxCost: mode === 3 ? MAX_COST : mode === 2 ? 3 : 50,
      });
      const reference = randomPermutation(n, rng);

      it(`n=${n} trial=${t} mode=${mode}：先最小成本、再最小变更（穷举核对）`, () => {
        const oracleAll = bruteForce(costs);
        if (oracleAll === null) {
          expect(() => migrateWithReference(costs, reference)).toThrow(NoPerfectAssignmentError);
          return;
        }
        const result = migrateWithReference(costs, reference);
        expectValidMigration(costs, reference, result);
        expectMatchesOracle(costs, reference, result);
      });
    }
  }
});

describe('迁移两级目标：并列解时优先保留旧线', () => {
  it('全零矩阵：任意排列同成本，参考本身必须被原样保留（0 变更）', () => {
    for (const reference of [
      [0, 1, 2],
      [2, 0, 1],
      [1, 2, 0],
    ]) {
      const costs = [
        [0, 0, 0],
        [0, 0, 0],
        [0, 0, 0],
      ];
      const result = migrateWithReference(costs, reference);
      expect(result.totalCost).toBe(0);
      expect(result.assignment).toEqual(reference);
      expect(result.changedRows).toBe(0);
    }
  });

  it('唯一最优等于参考：0 变更', () => {
    const costs = [
      [1, 9, 9],
      [9, 2, 9],
      [9, 9, 3],
    ];
    const result = migrateWithReference(costs, [0, 1, 2]);
    expect(result.assignment).toEqual([0, 1, 2]);
    expect(result.totalCost).toBe(6);
    expect(result.changedRows).toBe(0);
  });

  it('同成本并列：必须选保留旧线最多的那一个', () => {
    // 2×2 平局：两个对角排列成本都是 10。
    const costs = [
      [5, 5],
      [5, 5],
    ];
    // 参考 [0,1]：保持 0 变更；参考 [1,0]：交叉方案 0 变更。
    expect(migrateWithReference(costs, [0, 1]).assignment).toEqual([0, 1]);
    expect(migrateWithReference(costs, [1, 0]).assignment).toEqual([1, 0]);
  });

  it('成本必须最优：旧线更便宜不代表要迁就，先保最小总成本', () => {
    // 贪心反例矩阵：参考沿对角线 [0,1]=101，交叉 [1,0]=40 才最优。
    const costs = [
      [1, 20],
      [20, 100],
    ];
    const result = migrateWithReference(costs, [0, 1]);
    expect(result.totalCost).toBe(40);
    expect(result.assignment).toEqual([1, 0]);
    expect(result.changedRows).toBe(2);
  });

  it('部分可保留：在最优集合内最大化一致行数', () => {
    // 行 2 必然占列 2（代价 0）；行 0/1 在列 0/1 上同价。
    const costs = [
      [0, 0, 7],
      [0, 0, 7],
      [9, 9, 0],
    ];
    // 参考 [1,0,2]：行 2 必保留，前两行交叉方案 [1,0,2] 本身最优 => 0 变更
    let result = migrateWithReference(costs, [1, 0, 2]);
    expect(result.assignment).toEqual([1, 0, 2]);
    expect(result.changedRows).toBe(0);

    // 参考 [0,1,2]：原样也最优 => 0 变更（两种并列都可达，选参考）
    result = migrateWithReference(costs, [0, 1, 2]);
    expect(result.assignment).toEqual([0, 1, 2]);
    expect(result.changedRows).toBe(0);

    // 参考 [2,1,0]（合法排列）：行 0 的旧线在列 2（代价 7，非紧）、
    // 行 2 的旧线在列 0（代价 9，非紧），这两行必改；行 1 可保留列 1。
    result = migrateWithReference(costs, [2, 1, 0]);
    expect(result.totalCost).toBe(0);
    expect(result.changedRows).toBe(2);
    expect(result.assignment[1]).toBe(1);
  });

  it('断开块：块内并列各自尽量保留，块间不串扰', () => {
    const costs = [
      [1, 1, null, null],
      [1, 1, null, null],
      [null, null, 2, 2],
      [null, null, 2, 2],
    ];
    const reference = [1, 0, 3, 2]; // 两块都交叉，交叉方案同样最优
    const result = migrateWithReference(costs, reference);
    expect(result.totalCost).toBe(6);
    expect(result.assignment).toEqual(reference);
    expect(result.changedRows).toBe(0);
  });
});

describe('迁移两级目标：参考旧线在新矩阵中已禁配', () => {
  it('禁配的参考边不参与保留，该行计入变更，其余仍尽量保留', () => {
    // 行 0 只能配列 0；行 1 两列均可。
    const costs = [
      [5, null],
      [6, 8],
    ];
    // 参考 [0,1]：全部可行且唯一最优 5+8=13 => 0 变更
    let result = migrateWithReference(costs, [0, 1]);
    expect(result.assignment).toEqual([0, 1]);
    expect(result.changedRows).toBe(0);

    // 参考 [1,0]：(0,1) 已禁配，行0必须回列0，行1只能列1 => 2 行变更
    result = migrateWithReference(costs, [1, 0]);
    expect(result.assignment).toEqual([0, 1]);
    expect(result.totalCost).toBe(13);
    expect(result.changedRows).toBe(2);
  });

  it('禁配参考边下仍在最优集合中最小化变更（穷举核对）', () => {
    const rng = mulberry32(2026092901);
    for (let t = 0; t < 100; t++) {
      const n = 1 + Math.floor(rng() * 5);
      const costs = randomCostMatrix(n, rng, { forbiddenRate: 0.3, maxCost: 4 });
      const p = Array.from({ length: n }, (_, j) => j);
      for (let i = n - 1; i > 0; i--) {
        const k = Math.floor(rng() * (i + 1));
        [p[i], p[k]] = [p[k], p[i]];
      }
      const oracle = bruteForceMigrate(costs, p);
      if (oracle === null) {
        expect(() => migrateWithReference(costs, p)).toThrow(NoPerfectAssignmentError);
      } else {
        const result = migrateWithReference(costs, p);
        expectValidMigration(costs, p, result);
        expectMatchesOracle(costs, p, result);
      }
    }
  });
});

describe('迁移两级目标：第一级目标与无参考求解完全一致', () => {
  it('任何参考下总代价都等于普通匈牙利最小值（第二级绝不抬高成本）', () => {
    const rng = mulberry32(42424242);
    for (let t = 0; t < 150; t++) {
      const n = 1 + Math.floor(rng() * 6);
      const costs = randomCostMatrix(n, rng, { forbiddenRate: rng() * 0.5, maxCost: 6 });
      const p = Array.from({ length: n }, (_, j) => j);
      for (let i = n - 1; i > 0; i--) {
        const k = Math.floor(rng() * (i + 1));
        [p[i], p[k]] = [p[k], p[i]];
      }
      let base;
      try {
        base = hungarian(costs);
      } catch {
        expect(() => migrateWithReference(costs, p)).toThrow(NoPerfectAssignmentError);
        return;
      }
      const result = migrateWithReference(costs, p);
      expect(result.totalCost).toBe(base.totalCost);
      expectValidMigration(costs, p, result);
    }
  });

  it('新矩阵无完美匹配：迁移同样抛出', () => {
    const costs = [
      [5, null, null],
      [2, null, null],
      [7, 1, 3],
    ];
    expect(() => migrateWithReference(costs, [0, 1, 2])).toThrow(NoPerfectAssignmentError);
    expect(() => migrateWithReference(costs, [2, 1, 0])).toThrow(NoPerfectAssignmentError);
  });
});

describe('迁移两级目标：大代价精度（禁止放大系数合并目标）', () => {
  it('1e12 量级且并列：两级结论精确，总代价为安全整数', () => {
    // 两对角块各边均为 1e12，4! 中大量同价；参考为块内交叉排列。
    const C = MAX_COST;
    const costs = [
      [C, C, null, null],
      [C, C, null, null],
      [null, null, C, C],
      [null, null, C, C],
    ];
    const reference = [1, 0, 3, 2];
    const result = migrateWithReference(costs, reference);
    expect(result.totalCost).toBe(C * 4); // 4e14
    expect(Number.isSafeInteger(result.totalCost)).toBe(true);
    expect(result.assignment).toEqual(reference);
    expect(result.changedRows).toBe(0);
  });

  it('n=400 全 1e12、参考任意排列：0 变更且 4e14 精确（第二次匈牙利只走 0/1 权）', () => {
    const n = 400;
    const costs = Array.from({ length: n }, () => new Array(n).fill(MAX_COST));
    const reference = Array.from({ length: n }, (_, i) => (i + 7) % n); // 非恒等排列
    const started = performance.now();
    const result = migrateWithReference(costs, reference);
    expect(Number.isSafeInteger(result.totalCost)).toBe(true);
    expect(result.totalCost).toBe(MAX_COST * n);
    expect(result.assignment).toEqual(reference);
    expect(result.changedRows).toBe(0);
    expect(performance.now() - started).toBeLessThan(3000);
  });
});
