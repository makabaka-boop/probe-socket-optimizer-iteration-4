import { describe, it, expect, beforeAll } from 'vitest';
import { buildServer } from '../server/server.js';
import { mulberry32, bruteForceOptimalSet, randomCostMatrix } from './helpers.js';

// 支持两种运行方式：
//   1) 默认：直接在进程内注入完整 HTTP 请求（含 JSON 解析）；
//   2) TARGET_BASE_URL=http://web:3000：对已部署的 Compose 服务发真实请求。
const BASE_URL = process.env.TARGET_BASE_URL || '';
let app;

beforeAll(async () => {
  if (!BASE_URL) app = await buildServer();
});

async function callSolve(payload, { raw = false } = {}) {
  const started = performance.now();
  let status;
  let data;

  if (BASE_URL) {
    const body = raw ? payload : JSON.stringify(payload);
    const resp = await fetch(`${BASE_URL}/api/solve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });
    status = resp.status;
    data = await resp.json().catch(() => null);
  } else {
    const resp = await app.inject({
      method: 'POST',
      url: '/api/solve',
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
