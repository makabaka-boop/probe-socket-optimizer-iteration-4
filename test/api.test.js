import { describe, it, expect, beforeAll } from 'vitest';
import { buildServer } from '../server/server.js';
import { mulberry32, bruteForceOptimalSet, bruteForceMigrate, randomCostMatrix } from './helpers.js';

// 支持两种运行方式：
//   1) 默认：直接在进程内注入完整 HTTP 请求（含 JSON 解析）；
//   2) TARGET_BASE_URL=http://web:3000：对已部署的 Compose 服务发真实请求。
const BASE_URL = process.env.TARGET_BASE_URL || '';
let app;

beforeAll(async () => {
  if (!BASE_URL) app = await buildServer();
});

async function callSolve(payload, { raw = false, path = '/api/solve' } = {}) {
  const started = performance.now();
  let status;
  let data;

  if (BASE_URL) {
    const body = raw ? payload : JSON.stringify(payload);
    const resp = await fetch(`${BASE_URL}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });
    status = resp.status;
    data = await resp.json().catch(() => null);
  } else {
    const resp = await app.inject({
      method: 'POST',
      url: path,
      headers: { 'content-type': 'application/json' },
      payload: raw ? payload : payload,
    });
    status = resp.statusCode;
    data = resp.json();
  }
  return { status, data, elapsedMs: performance.now() - started };
}

const good = [
  [90, 75, 120, 60],
  [35, 80, 55, 200],
  [110, 40, 95, 130],
  [65, 150, 70, 100],
];

function assertAssignmentPerfect(costs, assignment) {
  const n = costs.length;
  expect(assignment).toHaveLength(n);
  const used = new Set();
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const j = assignment[i];
    expect(j).toBeGreaterThanOrEqual(0);
    expect(j).toBeLessThan(n);
    expect(used.has(j)).toBe(false);
    used.add(j);
    expect(costs[i][j]).not.toBeNull();
    sum += costs[i][j];
  }
  return sum;
}

function randomPermutation(n, rng) {
  const p = Array.from({ length: n }, (_, j) => j);
  for (let i = n - 1; i > 0; i--) {
    const k = Math.floor(rng() * (i + 1));
    [p[i], p[k]] = [p[k], p[i]];
  }
  return p;
}

describe('POST /api/solve：成功', () => {
  it('返回覆盖全部行列的配对与精确最小总代价', async () => {
    const { status, data } = await callSolve({ costs: good });
    expect(status).toBe(200);
    expect(data.status).toBe('ok');
    expect(data.n).toBe(4);
    const sum = assertAssignmentPerfect(good, data.assignment);
    expect(sum).toBe(data.totalCost);
    // 该矩阵最优解 60+35+40+70 = 205
    expect(data.totalCost).toBe(205);
  });

  it('n=1：单个元素直接返回', async () => {
    const { status, data } = await callSolve({ costs: [[123]] });
    expect(status).toBe(200);
    expect(data.assignment).toEqual([0]);
    expect(data.totalCost).toBe(123);
  });

  it('n=1 且唯一格禁配 -> 409', async () => {
    const { status, data } = await callSolve({ costs: [[null]] });
    expect(status).toBe(409);
    expect(data.error).toBe('NO_PERFECT_ASSIGNMENT');
  });

  it('排除一个配对后重算：给出替代最优或无解', async () => {
    const first = await callSolve({ costs: good });
    expect(first.status).toBe(200);
    const i0 = 0;
    const j0 = first.data.assignment[0];

    const reduced = good.map((row) => row.slice());
    reduced[i0][j0] = null; // 页面“排除此配对”：该格设为禁配
    const second = await callSolve({ costs: reduced });

    if (second.status === 200) {
      const sum = assertAssignmentPerfect(reduced, second.data.assignment);
      expect(sum).toBe(second.data.totalCost);
      expect(second.data.assignment[0]).not.toBe(j0); // 原配对确实不再出现
      expect(second.data.totalCost).toBeGreaterThanOrEqual(first.data.totalCost);
    } else {
      expect(second.status).toBe(409);
      expect(second.data.error).toBe('NO_PERFECT_ASSIGNMENT');
    }
  });
});

describe('POST /api/solve：409 NO_PERFECT_ASSIGNMENT', () => {
  it('Hall 条件：两行只能配同一列', async () => {
    const { status, data } = await callSolve({
      costs: [
        [5, null, null],
        [2, null, null],
        [7, 1, 3],
      ],
    });
    expect(status).toBe(409);
    expect(data.status).toBe('error');
    expect(data.error).toBe('NO_PERFECT_ASSIGNMENT');
  });

  it('整行禁配', async () => {
    const { status, data } = await callSolve({
      costs: [
        [5, 1, 2],
        [null, null, null],
        [2, 3, 4],
      ],
    });
    expect(status).toBe(409);
    expect(data.error).toBe('NO_PERFECT_ASSIGNMENT');
  });
});

describe('POST /api/solve：422 INVALID_INPUT', () => {
  const badCases = [
    ['请求体为 null', null],
    ['请求体是数组', [1, 2, 3]],
    ['缺少 costs', {}],
    ['costs 不是数组', { costs: 123 }],
    ['n=0 空矩阵', { costs: [] }],
    ['n=401 超上限', { costs: Array.from({ length: 401 }, () => new Array(401).fill(0)) }],
    ['缺行：第二行不是数组', { costs: [[1, 2], null] }],
    ['错维度：行长不一致', { costs: [[1, 2, 3], [4, 5], [6, 7, 8]] }],
    ['非方阵（2 行 3 列）', { costs: [[1, 2, 3], [4, 5, 6]] }],
    ['元素为字符串', { costs: [[1, 'x'], [3, 4]] }],
    ['元素为小数', { costs: [[1, 2.5], [3, 4]] }],
    ['元素为布尔', { costs: [[true, 2], [3, 4]] }],
    ['元素越界（负数）', { costs: [[-1, 2], [3, 4]] }],
    ['元素越界（>1e12）', { costs: [[1, 1_000_000_000_001], [3, 4]] }],
    ['元素为对象', { costs: [[{}, 2], [3, 4]] }],
  ];

  for (const [name, payload] of badCases) {
    it(name, async () => {
      const { status, data } = await callSolve(payload);
      expect(status).toBe(422);
      expect(data.status).toBe('error');
      expect(data.error).toBe('INVALID_INPUT');
    });
  }

  it('JSON 语法错误同样为 422', async () => {
    const { status, data } = await callSolve('{ costs: [[1,2],', { raw: true });
    expect(status).toBe(422);
    expect(data.error).toBe('INVALID_INPUT');
  });
});

describe('POST /api/solve：必然连线标记', () => {
  it('成功响应在同一次返回中携带与 assignment 对齐的 pairFlags', async () => {
    const { status, data } = await callSolve({ costs: good });
    expect(status).toBe(200);
    expect(Array.isArray(data.pairFlags)).toBe(true);
    expect(data.pairFlags).toHaveLength(4);
    for (const flag of data.pairFlags) {
      expect(typeof flag.forced).toBe('boolean');
      expect(Number.isInteger(flag.alternatives)).toBe(true);
      expect(flag.alternatives).toBeGreaterThanOrEqual(0);
      expect(flag.forced).toBe(flag.alternatives === 0);
    }
  });

  it('全零矩阵：每条展示配对都可替换，alternatives=n-1', async () => {
    const zero = [
      [0, 0, 0],
      [0, 0, 0],
      [0, 0, 0],
    ];
    const { status, data } = await callSolve({ costs: zero });
    expect(status).toBe(200);
    expect(data.totalCost).toBe(0);
    expect(data.pairFlags).toHaveLength(3);
    expect(data.pairFlags.every((f) => f.forced === false && f.alternatives === 2)).toBe(true);
  });

  it('唯一可行排列：全部必然，alternatives=0', async () => {
    const costs = [
      [5, null, null],
      [null, 7, null],
      [null, null, 9],
    ];
    const { status, data } = await callSolve({ costs });
    expect(status).toBe(200);
    expect(data.pairFlags.every((f) => f.forced === true && f.alternatives === 0)).toBe(true);
  });

  it('禁配 + 断开块：标记与独立穷举预言机一致（多轮小矩阵）', async () => {
    const rng = mulberry32(2026092301);
    for (let t = 0; t < 60; t++) {
      const n = 1 + Math.floor(rng() * 5);
      const costs = randomCostMatrix(n, rng, {
        forbiddenRate: t % 3 === 0 ? 0.4 : t % 3 === 1 ? 0.2 : 0,
        maxCost: t % 2 === 0 ? 3 : 100,
      });
      const { status, data } = await callSolve({ costs });
      const oracle = bruteForceOptimalSet(costs);
      if (oracle === null) {
        expect(status).toBe(409);
        expect(data.pairFlags).toBeUndefined(); // 失败不携带任何标记
        continue;
      }
      expect(status).toBe(200);
      expect(data.totalCost).toBe(oracle.totalCost);
      const shownOptimal = oracle.optimalAssignments.some((p) =>
        p.every((j, i) => j === data.assignment[i])
      );
      expect(shownOptimal).toBe(true);
      const expected = oracle.flagsFor(data.assignment);
      expect(data.pairFlags).toEqual(expected);
    }
  });

  it('409 响应不携带方案与标记（不留旧标记由页面保证，接口本身不返回）', async () => {
    const { status, data } = await callSolve({
      costs: [
        [5, null, null],
        [2, null, null],
        [7, 1, 3],
      ],
    });
    expect(status).toBe(409);
    expect(data.assignment).toBeUndefined();
    expect(data.totalCost).toBeUndefined();
    expect(data.pairFlags).toBeUndefined();
  });

  it('422 响应同样不携带标记', async () => {
    const { status, data } = await callSolve({ costs: [[1, 2]] });
    expect(status).toBe(422);
    expect(data.pairFlags).toBeUndefined();
  });

  it('排除一条展示配对后重算：标记针对新展示方案重新给出，价格不受分析影响', async () => {
    // 同价 2×2 平局：第一次两条都可替换；排除 (0,j0) 后只剩唯一方案，全部必然。
    const tie = [
      [5, 5],
      [5, 5],
    ];
    const first = await callSolve({ costs: tie });
    expect(first.status).toBe(200);
    expect(first.data.totalCost).toBe(10);
    expect(first.data.pairFlags.every((f) => f.forced === false)).toBe(true);
    const j0 = first.data.assignment[0];

    const reduced = tie.map((row) => row.slice());
    reduced[0][j0] = null;
    const second = await callSolve({ costs: reduced });
    expect(second.status).toBe(200);
    expect(second.data.assignment[0]).not.toBe(j0);
    // 替代问题中每个探针只剩唯一列：新方案全部必然，而非沿用排除前的可替换标记
    expect(second.data.pairFlags.every((f) => f.forced === true && f.alternatives === 0)).toBe(true);
  });
});

describe('POST /api/migrate：两级目标迁移', () => {
  async function callMigrate(payload, opts) {
    return callSolve(payload, { ...opts, path: '/api/migrate' });
  }

  it('参考即最优：返回新配对、精确费用与 0 变更行', async () => {
    const { status, data } = await callMigrate({ costs: good, reference: [3, 0, 1, 2] });
    expect(status).toBe(200);
    expect(data.status).toBe('ok');
    expect(data.mode).toBe('migrate');
    expect(data.n).toBe(4);
    expect(data.assignment).toEqual([3, 0, 1, 2]);
    expect(data.totalCost).toBe(205);
    expect(data.changedRows).toBe(0);
    expect(data.reference).toEqual([3, 0, 1, 2]);
    // 迁移模式不携带任何必然/可替换标记
    expect(data.pairFlags).toBeUndefined();
  });

  it('全零并列：服务端必须返回参考本身（0 变更），而非任意最优', async () => {
    const zero = [
      [0, 0, 0],
      [0, 0, 0],
      [0, 0, 0],
    ];
    for (const reference of [
      [2, 1, 0],
      [1, 2, 0],
    ]) {
      const { status, data } = await callMigrate({ costs: zero, reference });
      expect(status).toBe(200);
      expect(data.totalCost).toBe(0);
      expect(data.assignment).toEqual(reference);
      expect(data.changedRows).toBe(0);
    }
  });

  it('先最小成本、再最小变更：随机小矩阵与穷举两级预言机一致', async () => {
    const rng = mulberry32(2026092902);
    for (let t = 0; t < 80; t++) {
      const n = 1 + Math.floor(rng() * 5);
      const costs = randomCostMatrix(n, rng, {
        forbiddenRate: t % 3 === 0 ? 0.35 : t % 3 === 1 ? 0.15 : 0,
        maxCost: t % 2 === 0 ? 4 : 1000,
      });
      const reference = randomPermutation(n, rng);
      const { status, data } = await callMigrate({ costs, reference });
      const oracle = bruteForceMigrate(costs, reference);
      if (oracle === null) {
        expect(status).toBe(409);
        expect(data.error).toBe('NO_PERFECT_ASSIGNMENT');
        continue;
      }
      expect(status).toBe(200);
      // 第一级：精确最小总费用（可按当前矩阵复算）
      const sum = assertAssignmentPerfect(costs, data.assignment);
      expect(sum).toBe(data.totalCost);
      expect(data.totalCost).toBe(oracle.totalCost);
      // 第二级：同成本完美匹配中变更行最少
      let changed = 0;
      for (let i = 0; i < n; i++) if (data.assignment[i] !== reference[i]) changed++;
      expect(data.changedRows).toBe(changed);
      expect(data.changedRows).toBe(oracle.minChanged);
      // 结果必须是两级最优集合中的一员
      const isBest = oracle.optimalAssignments.some((p) =>
        p.every((j, i) => j === data.assignment[i])
      );
      expect(isBest).toBe(true);
    }
  });

  it('参考旧线在新矩阵中已禁配：仍可迁移，该行计入变更', async () => {
    // 行 0 只能配列 0。
    const costs = [
      [5, null],
      [6, 8],
    ];
    const { status, data } = await callMigrate({ costs, reference: [1, 0] });
    expect(status).toBe(200);
    expect(data.assignment).toEqual([0, 1]);
    expect(data.totalCost).toBe(13);
    expect(data.changedRows).toBe(2); // (0,1) 已禁配，无法保留
  });

  it('参考旧线全禁配但可行解唯一：正常返回，不 422', async () => {
    const costs = [
      [5, null, null],
      [null, 7, null],
      [null, null, 9],
    ];
    const { status, data } = await callMigrate({ costs, reference: [2, 0, 1] });
    expect(status).toBe(200);
    expect(data.assignment).toEqual([0, 1, 2]);
    expect(data.changedRows).toBe(3);
  });

  it('新矩阵无完美匹配：409 且不携带方案', async () => {
    const costs = [
      [5, null, null],
      [2, null, null],
      [7, 1, 3],
    ];
    const { status, data } = await callMigrate({ costs, reference: [0, 1, 2] });
    expect(status).toBe(409);
    expect(data.error).toBe('NO_PERFECT_ASSIGNMENT');
    expect(data.assignment).toBeUndefined();
    expect(data.changedRows).toBeUndefined();
  });

  it('排除一个配对后重迁：仍为最小成本，变更数按新禁配重算', async () => {
    const first = await callMigrate({ costs: good, reference: [3, 0, 1, 2] });
    expect(first.status).toBe(200);
    const reduced = good.map((row) => row.slice());
    reduced[0][3] = null; // 排除参考的首条旧线
    const second = await callMigrate({ costs: reduced, reference: [3, 0, 1, 2] });
    if (second.status === 200) {
      expect(second.data.assignment[0]).not.toBe(3);
      expect(second.data.changedRows).toBeGreaterThanOrEqual(1);
      const sum = assertAssignmentPerfect(reduced, second.data.assignment);
      expect(sum).toBe(second.data.totalCost);
      // 第一级目标仍是新矩阵的最小总成本（不因参考抬高）
      const oracle = bruteForceMigrate(reduced, [3, 0, 1, 2]);
      expect(second.data.totalCost).toBe(oracle.totalCost);
      expect(second.data.changedRows).toBe(oracle.minChanged);
    } else {
      expect(second.status).toBe(409);
    }
  });
});

describe('POST /api/migrate：参考非法在求解前整批 422', () => {
  const good4 = good;
  const badRefs = [
    ['缺少 reference 字段', { costs: good4 }],
    ['reference 为 null', { costs: good4, reference: null }],
    ['reference 不是数组', { costs: good4, reference: '3012' }],
    ['reference 是对象', { costs: good4, reference: { 0: 3 } }],
    ['规模不符：长度不足', { costs: good4, reference: [3, 0, 1] }],
    ['规模不符：长度超长', { costs: good4, reference: [3, 0, 1, 2, 0] }],
    ['列重复（非排列）', { costs: good4, reference: [3, 0, 0, 2] }],
    ['列越界（=n）', { costs: good4, reference: [3, 0, 1, 4] }],
    ['列越界（负数）', { costs: good4, reference: [3, -1, 1, 2] }],
    ['非整数列', { costs: good4, reference: [3, 0, 1.5, 2] }],
    ['字符串列', { costs: good4, reference: [3, '0', 1, 2] }],
    ['null 元素', { costs: good4, reference: [3, null, 1, 2] }],
  ];
  for (const [name, payload] of badRefs) {
    it(name, async () => {
      const { status, data } = await callSolve(payload, { path: '/api/migrate' });
      expect(status).toBe(422);
      expect(data.status).toBe('error');
      expect(data.error).toBe('INVALID_INPUT');
      expect(data.assignment).toBeUndefined();
      expect(data.changedRows).toBeUndefined();
    });
  }

  it('矩阵本身非法时同样 422（先校验矩阵）', async () => {
    const { status, data } = await callSolve({ costs: [[1, 2]], reference: [0, 1] }, { path: '/api/migrate' });
    expect(status).toBe(422);
    expect(data.error).toBe('INVALID_INPUT');
  });

  it('参考命中禁配边不算非法：不 422，正常求解', async () => {
    const costs = [
      [5, null],
      [6, 8],
    ];
    const { status, data } = await callSolve({ costs, reference: [1, 0] }, { path: '/api/migrate' });
    expect(status).toBe(200);
    expect(data.changedRows).toBe(2);
  });

  it('/api/migrate 与 /api/solve 互不影响：旧接口忽略 reference，响应无 mode/changedRows', async () => {
    const { status, data } = await callSolve({ costs: good, reference: [0, 1, 2, 3] });
    expect(status).toBe(200);
    expect(data.mode).toBeUndefined();
    expect(data.changedRows).toBeUndefined();
    expect(data.reference).toBeUndefined();
    expect(Array.isArray(data.pairFlags)).toBe(true); // 旧版必然分析原样保留
    expect(data.totalCost).toBe(205);
  });
});

describe('POST /api/migrate：n=400 性能与精度', () => {
  it('三秒内返回：两级匈牙利均在安全整数范围内', async () => {
    const n = 400;
    const rng = mulberry32(2026092903);
    const costs = Array.from({ length: n }, () =>
      Array.from({ length: n }, () => Math.floor(rng() * 1_000_000))
    );
    const reference = randomPermutation(n, rng);
    const { status, data, elapsedMs } = await callSolve({ costs, reference }, { path: '/api/migrate' });
    expect(status).toBe(200);
    expect(data.assignment).toHaveLength(n);
    expect(Number.isSafeInteger(data.totalCost)).toBe(true);
    expect(data.changedRows).toBeGreaterThanOrEqual(0);
    expect(data.changedRows).toBeLessThanOrEqual(n);
    const sum = assertAssignmentPerfect(costs, data.assignment);
    expect(sum).toBe(data.totalCost);
    // eslint-disable-next-line no-console
    console.log(`n=${n} 迁移端到端耗时 ${Math.round(elapsedMs)} ms，变更 ${data.changedRows} 行`);
    expect(elapsedMs).toBeLessThan(3000);
  });
});

describe('POST /api/solve：n=400 稠密矩阵性能与精度', () => {
  it('三秒内经 API 返回精确最优解', async () => {
    const n = 400;
    const rng = mulberry32(20260918);
    const costs = Array.from({ length: n }, () =>
      Array.from({ length: n }, () => Math.floor(rng() * 1_000_000))
    );

    const { status, data, elapsedMs } = await callSolve({ costs });
    expect(status).toBe(200);
    expect(data.assignment).toHaveLength(n);
    expect(data.pairFlags).toHaveLength(n); // 分析与方案同一次返回
    for (const flag of data.pairFlags) expect(typeof flag.forced).toBe('boolean');
    // 精确复算（小于 2^53）
    const sum = assertAssignmentPerfect(costs, data.assignment);
    expect(sum).toBe(data.totalCost);
    expect(Number.isSafeInteger(data.totalCost)).toBe(true);
    // 独立上界：任何可行解都不差于「每行最小值之和」之外 —— 这里用简单合理性检查
    expect(data.totalCost).toBeGreaterThan(0);
    // eslint-disable-next-line no-console
    console.log(`n=${n} API 端到端耗时 ${Math.round(elapsedMs)} ms，总代价 ${data.totalCost}`);
    expect(elapsedMs).toBeLessThan(3000);
  });
});
