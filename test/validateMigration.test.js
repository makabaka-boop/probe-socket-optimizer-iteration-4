import { describe, it, expect } from 'vitest';
import { validateMigrationResponse } from '../src/validateMigration.js';

const COSTS = [
  [90, 75, 120, 60],
  [35, 80, 55, 200],
  [110, 40, 95, 130],
  [65, 150, 70, 100],
];
const REFERENCE = [3, 0, 1, 2];
const ASSIGNMENT = [3, 0, 1, 2];
const TOTAL = 205;

function okBody(overrides = {}) {
  return {
    status: 'ok',
    mode: 'migrate',
    n: 4,
    assignment: ASSIGNMENT,
    totalCost: TOTAL,
    changedRows: 0,
    reference: REFERENCE,
    ...overrides,
  };
}

describe('validateMigrationResponse：合法响应', () => {
  it('完整响应通过：费用与变更行均可按当前矩阵/参考复算', () => {
    const v = validateMigrationResponse(okBody(), COSTS, REFERENCE);
    expect(v.ok).toBe(true);
    expect(v.assignment).toEqual(ASSIGNMENT);
    expect(v.totalCost).toBe(205);
    expect(v.changedRows).toBe(0);
  });

  it('部分改线：changedRows 与逐行比对一致', () => {
    // 选另一个合法排列 [2,0,1,3]，费用 120+35+40+100=295，仅行 0、3 改变
    const body = okBody({ assignment: [2, 0, 1, 3], totalCost: 295, changedRows: 2 });
    const v = validateMigrationResponse(body, COSTS, REFERENCE);
    expect(v.ok).toBe(true);
    expect(v.changedRows).toBe(2);
  });

  it('n=1 边界', () => {
    const v = validateMigrationResponse(
      { status: 'ok', mode: 'migrate', n: 1, assignment: [0], totalCost: 7, changedRows: 0, reference: [0] },
      [[7]],
      [0]
    );
    expect(v.ok).toBe(true);
  });

  it('不接受 pairFlags（迁移模式不带必然标记）——多余字段不影响通过', () => {
    // 响应里混入 pairFlags 应被忽略（迁移页面也不会渲染），核心字段合法即通过
    const v = validateMigrationResponse(okBody({ pairFlags: [] }), COSTS, REFERENCE);
    expect(v.ok).toBe(true);
  });
});

describe('validateMigrationResponse：模式与身份不符', () => {
  const cases = [
    ['mode 缺失', okBody({ mode: undefined })],
    ['mode=solve（旧接口响应串到迁移）', okBody({ mode: 'solve' })],
    ['n 不符（大于当前矩阵）', okBody({ n: 5 })],
    ['n 不符（小于当前矩阵）', okBody({ n: 3 })],
    ['n 不是整数', okBody({ n: '4' })],
    ['assignment 短数组', okBody({ assignment: [3, 0, 1] })],
    ['assignment 重复列', okBody({ assignment: [3, 0, 0, 2] })],
    ['assignment 越界列', okBody({ assignment: [3, 0, 1, 4] })],
    ['assignment 非整数', okBody({ assignment: [3, 0, 1, 1.5] })],
  ];
  for (const [name, body] of cases) {
    it(name, () => {
      expect(validateMigrationResponse(body, COSTS, REFERENCE).ok).toBe(false);
    });
  }

  it('响应不是对象', () => {
    expect(validateMigrationResponse(null, COSTS, REFERENCE).ok).toBe(false);
    expect(validateMigrationResponse([1, 2], COSTS, REFERENCE).ok).toBe(false);
  });

  it('当前参考缺失或规模不符：拒绝（无法核对变更与归属）', () => {
    expect(validateMigrationResponse(okBody(), COSTS, null).ok).toBe(false);
    expect(validateMigrationResponse(okBody(), COSTS, [3, 0, 1]).ok).toBe(false);
  });
});

describe('validateMigrationResponse：禁配格与费用复算', () => {
  it('assignment 命中禁配格', () => {
    const costs = COSTS.map((r) => r.slice());
    costs[0][3] = null;
    const v = validateMigrationResponse(okBody({ totalCost: 145 }), costs, REFERENCE);
    expect(v.ok).toBe(false);
    expect(v.reason).toContain('禁配');
  });

  it('totalCost 无法按当前矩阵复算', () => {
    expect(validateMigrationResponse(okBody({ totalCost: 206 }), COSTS, REFERENCE).ok).toBe(false);
  });

  it('totalCost 非法数值', () => {
    expect(validateMigrationResponse(okBody({ totalCost: '205' }), COSTS, REFERENCE).ok).toBe(false);
    expect(validateMigrationResponse(okBody({ totalCost: 205.5 }), COSTS, REFERENCE).ok).toBe(false);
    expect(validateMigrationResponse(okBody({ totalCost: Number.MAX_SAFE_INTEGER + 1 }), COSTS, REFERENCE).ok).toBe(false);
  });
});

describe('validateMigrationResponse：变更行复算', () => {
  it('changedRows 与当前参考不符（迟到响应改了参考）', () => {
    // assignment 全部与参考一致，却声称 2 行变更
    const v = validateMigrationResponse(okBody({ changedRows: 2 }), COSTS, REFERENCE);
    expect(v.ok).toBe(false);
    expect(v.reason).toContain('变更行数');
  });

  it('changedRows 越界/非整数', () => {
    expect(validateMigrationResponse(okBody({ changedRows: -1 }), COSTS, REFERENCE).ok).toBe(false);
    expect(validateMigrationResponse(okBody({ changedRows: 5 }), COSTS, REFERENCE).ok).toBe(false);
    expect(validateMigrationResponse(okBody({ changedRows: 0.5 }), COSTS, REFERENCE).ok).toBe(false);
    expect(validateMigrationResponse(okBody({ changedRows: '0' }), COSTS, REFERENCE).ok).toBe(false);
    expect(validateMigrationResponse(okBody({ changedRows: undefined }), COSTS, REFERENCE).ok).toBe(false);
  });

  it('矩阵改价后旧响应的费用不再可复算：拒绝', () => {
    const costs = COSTS.map((r, i) => (i === 0 ? r.map((v) => (v === 60 ? 61 : v)) : r));
    // 旧响应 totalCost=205，但当前矩阵复算为 206
    const v = validateMigrationResponse(okBody(), costs, REFERENCE);
    expect(v.ok).toBe(false);
    expect(v.reason).toContain('不一致');
  });
});

describe('validateMigrationResponse：回显参考归属', () => {
  it('缺少回显 reference：拒绝', () => {
    const body = okBody();
    delete body.reference;
    expect(validateMigrationResponse(body, COSTS, REFERENCE).ok).toBe(false);
  });

  it('回显 reference 长度不对：拒绝', () => {
    expect(validateMigrationResponse(okBody({ reference: [3, 0, 1] }), COSTS, REFERENCE).ok).toBe(false);
  });

  it('回显 reference 与当前参考逐行不一致（旧请求迟到/串参考）：拒绝', () => {
    // assignment=[0,1,2,3] 相对回显参考 [3,0,1,2] 为 4 行全改（费用 365），
    // 但页面当前参考已换成 [2,0,1,3]，归属不一致必须拒绝。
    const v = validateMigrationResponse(
      okBody({ assignment: [0, 1, 2, 3], totalCost: 365, changedRows: 4, reference: [3, 0, 1, 2] }),
      COSTS,
      [2, 0, 1, 3] // 当前参考已换成另一个
    );
    expect(v.ok).toBe(false);
    expect(v.reason).toContain('参考');
  });

  it('全部改线且费用、变更、归属全部一致：通过', () => {
    const assignment = [0, 1, 2, 3]; // 相对参考 [3,0,1,2] 完全错位，4 行全改
    const sum = 90 + 80 + 95 + 100; // 365
    const body = okBody({ assignment, totalCost: sum, changedRows: 4 });
    const v = validateMigrationResponse(body, COSTS, REFERENCE);
    expect(v.ok).toBe(true);
    expect(v.changedRows).toBe(4);
  });
});
