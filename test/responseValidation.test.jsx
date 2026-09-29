// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, fireEvent, act, cleanup } from '@testing-library/react';
import React from 'react';
import App from '../src/App.jsx';

// 伪造代理/缓存/滚动升级中旧服务返回的畸形“成功”响应，
// 核对：稳定协议错误、结果清理、矩阵零误标、旧版兼容。
beforeEach(() => {
  global.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

// 合法基线：默认 4×4 矩阵最优解 60+35+40+70=205，assignment=[3,0,1,2]。
const GOOD_ASSIGNMENT = [3, 0, 1, 2];
const GOOD_TOTAL = 205;
const ALL_FORCED_4 = [
  { forced: true, alternatives: 0 },
  { forced: true, alternatives: 0 },
  { forced: true, alternatives: 0 },
  { forced: true, alternatives: 0 },
];

function okBody(overrides = {}) {
  return {
    status: 'ok',
    n: 4,
    assignment: GOOD_ASSIGNMENT,
    totalCost: GOOD_TOTAL,
    pairFlags: ALL_FORCED_4,
    ...overrides,
  };
}

function okResp(overrides = {}) {
  return jsonResponse(200, okBody(overrides));
}

// 渲染并发起一次求解，返回常用查询工具。
async function renderAndSolve(fetchImpl) {
  vi.stubGlobal('fetch', vi.fn(fetchImpl));
  const utils = render(<App />);
  fireEvent.click(utils.getByText('求解最小分配'));
  return utils;
}

// 畸形响应上屏后的统一断言：稳定协议错误 + 结果清理 + 矩阵零误标 + 不可继续排除。
async function expectProtocolErrorCleared(utils) {
  const { findByText, getByText, queryByText, queryAllByText, container } = utils;
  await findByText(/PROTOCOL_ERROR/);
  expect(getByText(/求解响应未通过校验/)).toBeTruthy();
  // 结果清理：不展示任何“最优方案”
  expect(container.querySelector('.result')).toBeNull();
  expect(queryByText('最优分配方案')).toBeNull();
  expect(container.querySelector('.recompute')).toBeNull();
  // 不可继续排除
  expect(queryAllByText('排除此配对')).toHaveLength(0);
  // 矩阵零误标：无配对高亮、无必然/可替换标记、无表头命中
  expect(container.querySelectorAll('.cell.matched')).toHaveLength(0);
  expect(container.querySelectorAll('.cell.match-forced')).toHaveLength(0);
  expect(container.querySelectorAll('.cell.match-flexible')).toHaveLength(0);
  expect(container.querySelectorAll('.pair-flag')).toHaveLength(0);
  expect(container.querySelectorAll('.col-head.matched-head')).toHaveLength(0);
}

describe('App 页面：畸形成功响应一律拒绝（稳定协议错误）', () => {
  const malformed = [
    ['assignment 短数组（缺行）', { assignment: [3, 0, 1] }],
    ['assignment 重复列', { assignment: [3, 0, 0, 2] }],
    ['assignment 越界列', { assignment: [3, 0, 1, 4] }],
    ['assignment 非整数列', { assignment: [3, 0, 1, 1.5] }],
    ['totalCost 与矩阵复算不符', { totalCost: 206 }],
    ['totalCost 非整数', { totalCost: 205.5 }],
    ['n 与当前矩阵不符', { n: 5 }],
    ['pairFlags 长度不足', { pairFlags: [ALL_FORCED_4[0]] }],
    ['pairFlags 不是数组', { pairFlags: 'forced' }],
    ['pairFlags 为 null（字段存在但不合法）', { pairFlags: null }],
    ['pairFlags.forced 非布尔', { pairFlags: [{ forced: 1, alternatives: 0 }, ...ALL_FORCED_4.slice(1)] }],
    ['pairFlags.alternatives 负数', { pairFlags: [{ forced: false, alternatives: -1 }, ...ALL_FORCED_4.slice(1)] }],
    ['pairFlags 自相矛盾（forced=true 且 alternatives>0）', { pairFlags: [{ forced: true, alternatives: 2 }, ...ALL_FORCED_4.slice(1)] }],
  ];

  for (const [name, overrides] of malformed) {
    it(name, async () => {
      const utils = await renderAndSolve(async () => okResp(overrides));
      await expectProtocolErrorCleared(utils);
    });
  }

  it('assignment 命中禁配格', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => okResp({ totalCost: 145 })));
    const utils = render(<App />);
    const { container, getByText } = utils;
    // 求解前先把 探针1→座4（代价 60）设为禁配
    const cell60 = Array.from(container.querySelectorAll('.cell-value')).find(
      (b) => b.textContent === '60'
    );
    fireEvent.click(cell60);
    const input = container.querySelector('.cell-input');
    fireEvent.change(input, { target: { value: 'x' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    // 旧服务仍按原矩阵返回 assignment[0]=3，命中禁配格
    fireEvent.click(getByText('求解最小分配'));
    await expectProtocolErrorCleared(utils);
  });
});

describe('App 页面：畸形响应后的结果清理', () => {
  it('先展示合法方案（含必然高亮），再收到畸形响应：方案与高亮一并清除', async () => {
    let call = 0;
    const utils = await renderAndSolve(async () => {
      call++;
      // 第一次：完全合法；第二次：重复列的畸形响应
      return call === 1 ? okResp() : okResp({ assignment: [3, 0, 0, 2] });
    });
    const { findByText, getByText, container } = utils;

    await findByText('最优分配方案');
    expect(container.querySelectorAll('.pair-flag.is-forced')).toHaveLength(4);
    expect(container.querySelectorAll('.cell.match-forced')).toHaveLength(4);

    // 不编辑直接再次求解（模拟缓存/代理返回了畸形数据）
    fireEvent.click(getByText('求解最小分配'));
    await expectProtocolErrorCleared(utils);
  });

  it('排除配对的重算收到畸形响应：同样清除旧方案与旧标记', async () => {
    const utils = await renderAndSolve(async (url, init) => {
      const body = JSON.parse(init.body);
      if (body.costs[0][3] === null) {
        // 替代问题的“成功”响应被篡改：totalCost 无法复算
        return okResp({ assignment: [2, 0, 1, 3], totalCost: 999 });
      }
      return okResp();
    });
    const { findByText, getAllByText, container } = utils;

    await findByText('最优分配方案');
    expect(container.querySelectorAll('.cell.match-forced')).toHaveLength(4);

    fireEvent.click(getAllByText('排除此配对')[0]);
    await expectProtocolErrorCleared(utils);
  });

  it('协议错误后再次求解收到合法响应：正常恢复展示', async () => {
    let call = 0;
    const utils = await renderAndSolve(async () => {
      call++;
      return call === 1 ? okResp({ n: 9 }) : okResp();
    });
    const { findByText, getByText, container } = utils;

    await findByText(/PROTOCOL_ERROR/);
    fireEvent.click(getByText('求解最小分配'));
    await findByText('最优分配方案');
    expect(container.querySelectorAll('.cell.match-forced')).toHaveLength(4);
  });
});

describe('App 页面：旧版兼容', () => {
  it('完全缺少 pairFlags 的旧版合法响应：展示分配与总价，不显示分析标记，仍可排除', async () => {
    const utils = await renderAndSolve(async () => {
      const body = okBody();
      delete body.pairFlags; // 旧版服务：字段完全缺失
      return jsonResponse(200, body);
    });
    const { findByText, getByText, getAllByText, container } = utils;

    await findByText('最优分配方案');
    expect(getByText('205')).toBeTruthy();
    expect(getByText(/✓ 与服务器一致/)).toBeTruthy();
    // 不显示任何分析标记与汇总
    expect(container.querySelectorAll('.pair-flag')).toHaveLength(0);
    expect(container.querySelectorAll('.cell.match-forced')).toHaveLength(0);
    expect(container.querySelectorAll('.cell.match-flexible')).toHaveLength(0);
    // 但配对高亮与排除按钮仍在（是可操作方案）
    expect(container.querySelectorAll('.cell.matched')).toHaveLength(4);
    expect(getAllByText('排除此配对')).toHaveLength(4);
  });

  it('pairFlags 与 assignment 完整对应时正常渲染标记（正对照）', async () => {
    const utils = await renderAndSolve(async () => okResp());
    const { findByText, container } = utils;
    await findByText('最优分配方案');
    expect(container.querySelector('.pairs').querySelectorAll('.pair-flag.is-forced')).toHaveLength(4);
    expect(container.querySelectorAll('.cell.match-forced')).toHaveLength(4);
  });
});
