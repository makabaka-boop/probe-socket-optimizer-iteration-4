import { describe, it, expect } from 'vitest';
import { validateSolveResponse } from '../src/validateSolution.js';

// 默认 4×4 矩阵（与页面初始矩阵一致），最优解 60+35+40+70=205，assignment=[3,0,1,2]。
const COSTS = [
  [90, 75, 120, 60],
  [35, 80, 55, 200],
  [110, 40, 95, 130],
  [65, 150, 70, 100],
];
const ASSIGNMENT = [3, 0, 1, 2];
const TOTAL = 205;
const FLAGS = [
  { forced: true, alternatives: 0 },
  { forced: false, alternatives: 1 },
  { forced: false, alternatives: 2 },
  { forced: true, alternatives: 0 },
];

function okBody(overrides = {}) {
  return { status: 'ok', n: 4, assignment: ASSIGNMENT, totalCost: TOTAL, pairFlags: FLAGS, ...overrides };
}

describe('validateSolveResponse：合法响应', () => {
  it('完整响应（含 pairFlags）通过并原样返回标记', () => {
    const v = validateSolveResponse(okBody(), COSTS);
    expect(v.ok).toBe(true);
    expect(v.assignment).toEqual(ASSIGNMENT);
    expect(v.totalCost).toBe(TOTAL);
    expect(v.pairFlags).toEqual(FLAGS);
  });

  it('旧版响应：完全缺少 pairFlags 字段时合法，pairFlags 归一为 null', () => {
    const body = okBody();
    delete body.pairFlags;
    const v = validateSolveResponse(body, COSTS);
    expect(v.ok).toBe(true);
    expect(v.pairFlags).toBeNull();
  });

  it('n=1 边界', () => {
    const v = validateSolveResponse(
      { status: 'ok', n: 1, assignment: [0], totalCost: 123 },
      [[123]]
    );
    expect(v.ok).toBe(true);
  });
});

describe('validateSolveResponse：身份与结构不符', () => {
  const cases = [
    ['n 不符（大于当前矩阵）', okBody({ n: 5 })],
    ['n 不符（小于当前矩阵）', okBody({ n: 3 })],
    ['n 不是整数', okBody({ n: '4' })],
    ['缺 n 字段', (() => { const b = okBody(); delete b.n; return b; })()],
    ['assignment 短数组（缺行）', okBody({ assignment: [3, 0, 1] })],
    ['assignment 超长', okBody({ assignment: [3, 0, 1, 2, 0] })],
    ['assignment 不是数组', okBody({ assignment: '3012' })],
    ['缺 assignment', (() => { const b = okBody(); delete b.assignment; return b; })()],
    ['重复列', okBody({ assignment: [3, 0, 0, 2] })],
    ['越界列（=n）', okBody({ assignment: [3, 0, 1, 4] })],
    ['越界列（负数）', okBody({ assignment: [3, 0, 1, -1] })],
    ['非整数列', okBody({ assignment: [3, 0, 1, 1.5] })],
    ['字符串列', okBody({ assignment: [3, 0, 1, '2'] })],
    ['null 列', okBody({ assignment: [3, 0, 1, null] })],
  ];
  for (const [name, body] of cases) {
    it(name, () => {
      const v = validateSolveResponse(body, COSTS);
      expect(v.ok).toBe(false);
      expect(typeof v.reason).toBe('string');
    });
  }

  it('响应不是对象', () => {
    expect(validateSolveResponse(null, COSTS).ok).toBe(false);
    expect(validateSolveResponse([1, 2], COSTS).ok).toBe(false);
    expect(validateSolveResponse('ok', COSTS).ok).toBe(false);
  });
});

describe('validateSolveResponse：禁配格与费用复算', () => {
  it('assignment 命中禁配格', () => {
    const costs = COSTS.map((r) => r.slice());
    costs[0][3] = null; // 禁配 探针1→座4
    const v = validateSolveResponse(okBody({ totalCost: 145 }), costs);
    expect(v.ok).toBe(false);
    expect(v.reason).toContain('禁配');
  });

  it('totalCost 与本地复算不一致', () => {
    expect(validateSolveResponse(okBody({ totalCost: 206 }), COSTS).ok).toBe(false);
    expect(validateSolveResponse(okBody({ totalCost: 0 }), COSTS).ok).toBe(false);
  });

  it('totalCost 非法数值', () => {
    expect(validateSolveResponse(okBody({ totalCost: '205' }), COSTS).ok).toBe(false);
    expect(validateSolveResponse(okBody({ totalCost: 205.5 }), COSTS).ok).toBe(false);
    expect(validateSolveResponse(okBody({ totalCost: -205 }), COSTS).ok).toBe(false);
    expect(validateSolveResponse(okBody({ totalCost: Number.MAX_SAFE_INTEGER + 1 }), COSTS).ok).toBe(false);
    expect(validateSolveResponse(okBody({ totalCost: NaN }), COSTS).ok).toBe(false);
  });
});

describe('validateSolveResponse：迁移模式（expectedReference 非 null）', () => {
  const REF = [3, 0, 1, 2];

  function migrationBody(overrides = {}) {
    // 迁移成功基线：新配对即参考本身，零变更（参考恰好是最优 205 的展示配对）
    return {
      status: 'ok',
      n: 4,
      assignment: [3, 0, 1, 2],
      totalCost: 205,
      pairFlags: FLAGS,
      reference: [3, 0, 1, 2],
      changedRows: [],
      changedCount: 0,
      ...overrides,
    };
  }

  it('零变更迁移响应通过，返回 migration 归属信息', () => {
    const v = validateSolveResponse(migrationBody(), COSTS, REF);
    expect(v.ok).toBe(true);
    expect(v.migration).toEqual({ reference: REF, changedRows: [], changedCount: 0 });
  });

  it('有变更：另一个同成本最优配对时，changedRows 与复算一致', () => {
    // 构造一个 assignment=[2,0,1,3]、总价也为 205 的矩阵场景：
    // 直接以该 assignment 对 COSTS 复算（COSTS 上该配对成本不为 205），
    // 所以这里用独立的小矩阵做端到端断言。
    const costs = [
      [5, 5],
      [5, 5],
    ];
    const body = {
      status: 'ok',
      n: 2,
      assignment: [1, 0],
      totalCost: 10,
      pairFlags: [
        { forced: false, alternatives: 1 },
        { forced: false, alternatives: 1 },
      ],
      reference: [0, 1],
      changedRows: [0, 1],
      changedCount: 2,
    };
    const v = validateSolveResponse(body, costs, [0, 1]);
    expect(v.ok).toBe(true);
    expect(v.migration.changedRows).toEqual([0, 1]);
    expect(v.migration.changedCount).toBe(2);
  });

  it('普通模式请求（expectedReference=null）：迁移字段可有可无，migration 归一为 null', () => {
    const v = validateSolveResponse(migrationBody(), COSTS, null);
    expect(v.ok).toBe(true);
    expect(v.migration).toBeNull();
  });

  const malformedMigration = [
    ['缺 reference 回显', () => { const b = migrationBody(); delete b.reference; return b; }],
    ['reference 不是数组', () => migrationBody({ reference: '3012' })],
    ['reference 为 null', () => migrationBody({ reference: null })],
    ['reference 长度不足', () => migrationBody({ reference: [3, 0, 1] })],
    ['reference 内容不一致（串台/迟到响应）', () => migrationBody({ reference: [0, 1, 2, 3] })],
    ['reference 仅一行不同', () => migrationBody({ reference: [3, 0, 2, 1] })],
    ['缺 changedRows', () => { const b = migrationBody(); delete b.changedRows; return b; }],
    ['changedRows 不是数组', () => migrationBody({ changedRows: {} })],
    ['changedRows 含越界行', () => migrationBody({ changedRows: [4] })],
    ['changedRows 含负数', () => migrationBody({ changedRows: [-1] })],
    ['changedRows 重复', () => migrationBody({ changedRows: [0, 0] })],
    ['changedRows 未升序', () => migrationBody({ changedRows: [1, 0] })],
    ['changedRows 非整数', () => migrationBody({ changedRows: [0.5] })],
    ['changedCount 缺失', () => { const b = migrationBody(); delete b.changedCount; return b; }],
    ['changedCount 与行数不符', () => migrationBody({ changedCount: 1 })],
    ['changedCount 非安全整数', () => migrationBody({ changedCount: 0.5 })],
  ];
  for (const [name, make] of malformedMigration) {
    it(`迁移字段非法拒绝：${name}`, () => {
      const v = validateSolveResponse(make(), COSTS, REF);
      expect(v.ok).toBe(false);
      expect(typeof v.reason).toBe('string');
    });
  }

  it('changedRows 与 assignment/reference 的实际差异不符：拒绝', () => {
    // 响应声称零变更，但 assignment 第 0 行已改配列 0（reference[0]=3）
    const costs = [
      [5, 5],
      [5, 5],
    ];
    const body = {
      status: 'ok',
      n: 2,
      assignment: [0, 1],
      totalCost: 10,
      pairFlags: [
        { forced: false, alternatives: 1 },
        { forced: false, alternatives: 1 },
      ],
      reference: [1, 0],
      changedRows: [],
      changedCount: 0,
    };
    const v = validateSolveResponse(body, costs, [1, 0]);
    expect(v.ok).toBe(false);
    expect(v.reason).toContain('changedRows');
  });

  it('迁移模式下 changedRows 多报未变更行：拒绝', () => {
    const costs = [
      [5, 5],
      [5, 5],
    ];
    const body = {
      status: 'ok',
      n: 2,
      assignment: [0, 1],
      totalCost: 10,
      reference: [0, 1],
      changedRows: [1],
      changedCount: 1,
    };
    const v = validateSolveResponse(body, costs, [0, 1]);
    expect(v.ok).toBe(false);
  });

  it('迁移模式不改变基础校验：无法复算总价仍拒绝', () => {
    const v = validateSolveResponse(migrationBody({ totalCost: 999 }), COSTS, REF);
    expect(v.ok).toBe(false);
    expect(v.reason).toContain('totalCost');
  });

  it('迁移模式命中禁配格仍拒绝', () => {
    const costs = COSTS.map((r) => r.slice());
    costs[0][3] = null;
    const v = validateSolveResponse(migrationBody({ totalCost: 145 }), costs, REF);
    expect(v.ok).toBe(false);
    expect(v.reason).toContain('禁配');
  });
});

describe('validateSolveResponse：pairFlags 畸形标记', () => {
  const cases = [
    ['pairFlags 长度不足', []],
    ['pairFlags 长度不足（缺一行）', FLAGS.slice(0, 3)],
    ['pairFlags 超长', FLAGS.concat({ forced: true, alternatives: 0 })],
    ['pairFlags 不是数组（字符串）', 'forced'],
    ['pairFlags 不是数组（对象）', { forced: true }],
    ['pairFlags 为 null（字段存在但不合法）', null],
    ['元素为 null', [FLAGS[0], null, FLAGS[2], FLAGS[3]]],
    ['元素为数组', [FLAGS[0], [true, 0], FLAGS[2], FLAGS[3]]],
    ['forced 非布尔', [{ forced: 'yes', alternatives: 0 }, FLAGS[1], FLAGS[2], FLAGS[3]]],
    ['forced 缺失', [{ alternatives: 0 }, FLAGS[1], FLAGS[2], FLAGS[3]]],
    ['alternatives 负数', [FLAGS[0], { forced: false, alternatives: -1 }, FLAGS[2], FLAGS[3]]],
    ['alternatives 小数', [FLAGS[0], { forced: false, alternatives: 0.5 }, FLAGS[2], FLAGS[3]]],
    ['alternatives 超界（>n-1）', [FLAGS[0], { forced: false, alternatives: 4 }, FLAGS[2], FLAGS[3]]],
    ['alternatives 非数值', [FLAGS[0], { forced: false, alternatives: '1' }, FLAGS[2], FLAGS[3]]],
    ['forced=true 但 alternatives>0（矛盾）', [{ forced: true, alternatives: 2 }, FLAGS[1], FLAGS[2], FLAGS[3]]],
    ['forced=false 但 alternatives=0（矛盾）', [FLAGS[0], { forced: false, alternatives: 0 }, FLAGS[2], FLAGS[3]]],
  ];
  for (const [name, pairFlags] of cases) {
    it(name, () => {
      const v = validateSolveResponse(okBody({ pairFlags }), COSTS);
      expect(v.ok).toBe(false);
      expect(typeof v.reason).toBe('string');
    });
  }
});
