// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, fireEvent, act, cleanup } from '@testing-library/react';
import React from 'react';
import App from '../src/App.jsx';

// 迁移模式页面测试：固定旧接线参考、编辑后保留、规模改变清除、迁移求解/排除、
// 失败后的参考与结果归属，以及迟到/畸形响应不得上屏。
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

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// 普通成功：默认矩阵最优 [3,0,1,2]=205
function okPlain(assignment = [3, 0, 1, 2], totalCost = 205) {
  return jsonResponse(200, { status: 'ok', n: 4, assignment, totalCost });
}

// 迁移成功响应
function okMigration(assignment, totalCost, reference, changedRows, pairFlags) {
  return jsonResponse(200, {
    status: 'ok',
    n: reference.length,
    assignment,
    totalCost,
    pairFlags:
      pairFlags ||
      reference.map(() => ({ forced: true, alternatives: 0 })),
    reference,
    changedRows,
    changedCount: changedRows.length,
  });
}

async function solveOnce(utils) {
  fireEvent.click(utils.getByText('求解最小分配'));
  await utils.findByText('最优分配方案');
}

describe('App 迁移：固定旧接线参考', () => {
  it('先求解，再把当前完整配对固定为参考：出现参考面板且请求带 reference', async () => {
    const bodies = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url, init) => {
        const body = JSON.parse(init.body);
        bodies.push(body);
        if (body.reference) {
          return okMigration([3, 0, 1, 2], 205, body.reference, []);
        }
        return okPlain();
      })
    );
    const utils = render(<App />);
    const { getByText, findByText, container } = utils;
    await solveOnce(utils);

    // 固定前：没有迁移按钮可用性、没有参考面板
    expect(container.querySelector('.ref-panel')).toBeNull();
    fireEvent.click(getByText('固定当前配对为旧接线参考'));

    // 参考面板出现，列出 4 对旧接线
    await findByText('旧接线参考');
    expect(container.querySelectorAll('.ref-chip')).toHaveLength(4);

    // 发起迁移求解
    fireEvent.click(getByText('迁移求解（少改线）'));
    await findByText('迁移方案（同成本最少改线）');
    expect(bodies[1].reference).toEqual([3, 0, 1, 2]);
    expect(Array.isArray(bodies[1].costs)).toBe(true);

    // 零变更：不出现“变更行”徽标
    expect(container.querySelectorAll('.pair.changed')).toHaveLength(0);
    expect(container.querySelectorAll('.pair.kept')).toHaveLength(4);
    // 汇总文案中“共 0 行”被 <strong> 拆开，按段落匹配
    expect(container.querySelector('.migration-legend').textContent).toContain('共 0 行');
  });

  it('迁移返回变更行：变更配对与参考归属清楚展示，矩阵格同步高亮', async () => {
    vi.stubGlobal('fetch', async (url, init) => {
      const body = JSON.parse(init.body);
      if (!body.reference) return okPlain();
      // 新配对 [2,0,1,3]：行0、行3 变更，行1/2 保留
      return okMigration([2, 0, 1, 3], 295, body.reference, [0, 3], [
        { forced: false, alternatives: 1 },
        { forced: true, alternatives: 0 },
        { forced: true, alternatives: 0 },
        { forced: false, alternatives: 1 },
      ]);
    });
    const utils = render(<App />);
    const { getByText, findByText, getAllByText, container } = utils;
    await solveOnce(utils);
    fireEvent.click(getByText('固定当前配对为旧接线参考'));
    await findByText('旧接线参考');
    fireEvent.click(getByText('迁移求解（少改线）'));

    await findByText('迁移方案（同成本最少改线）');
    expect(getByText('295')).toBeTruthy();
    expect(container.querySelectorAll('.pair.changed')).toHaveLength(2);
    expect(container.querySelectorAll('.pair.kept')).toHaveLength(2);
    // “由座 X 改配”归属徽标：行0 旧座4、行3 旧座3
    expect(getAllByText(/由座/).map((e) => e.textContent).sort()).toEqual([
      '由座 3 改配',
      '由座 4 改配',
    ]);
    // 汇总变更探针行（1、4）
    expect(getByText(/探针 1、4/)).toBeTruthy();
    // 矩阵格高亮
    expect(container.querySelectorAll('.cell.match-changed')).toHaveLength(2);
    expect(container.querySelectorAll('.cell.match-kept')).toHaveLength(2);
    // 新配对的必然标记仍是本次重算的（行1/2 必然），不是沿用旧方案
    const pairsBox = container.querySelector('.pairs');
    expect(pairsBox.querySelectorAll('.pair-flag.is-forced')).toHaveLength(2);
    expect(pairsBox.querySelectorAll('.pair-flag.is-flexible')).toHaveLength(2);
  });
});

describe('App 迁移：编辑、禁配与参考归属', () => {
  it('编辑成本格后参考保留，仍可发起迁移；改规模则清除参考', async () => {
    vi.stubGlobal('fetch', async (url, init) => {
      const body = JSON.parse(init.body);
      if (body.reference) return okMigration(body.reference, 205, body.reference, []);
      return okPlain();
    });
    const utils = render(<App />);
    const { getByText, findByText, getByDisplayValue, container } = utils;
    await solveOnce(utils);
    fireEvent.click(getByText('固定当前配对为旧接线参考'));
    await findByText('旧接线参考');

    // 编辑一个格：方案清除但参考保留
    const cell90 = Array.from(container.querySelectorAll('.cell-value')).find(
      (b) => b.textContent === '90'
    );
    fireEvent.click(cell90);
    const input = container.querySelector('.cell-input');
    fireEvent.change(input, { target: { value: '123' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(container.querySelectorAll('.ref-chip')).toHaveLength(4);
    expect(getByText('迁移求解（少改线）').closest('button').disabled).toBe(false);

    // 改规模到 3：参考随规模改变被清除
    fireEvent.change(getByDisplayValue('4'), { target: { value: '3' } });
    fireEvent.click(getByText('应用'));
    expect(container.querySelector('.ref-panel')).toBeNull();
    expect(getByText('迁移求解（少改线）').closest('button').disabled).toBe(true);
  });

  it('参考边在新矩阵被设为禁配：参考面板标“已禁配”，迁移响应仍可上屏', async () => {
    vi.stubGlobal('fetch', async (url, init) => {
      const body = JSON.parse(init.body);
      if (!body.reference) return okPlain();
      // 行0 旧边 (0,3) 已禁配；迁移返回 [2,0,1,3]，相对参考 [3,0,1,2] 变更行为 0、3
      return okMigration([2, 0, 1, 3], 295, body.reference, [0, 3]);
    });
    const utils = render(<App />);
    const { getByText, findByText, container } = utils;
    await solveOnce(utils);
    fireEvent.click(getByText('固定当前配对为旧接线参考'));
    await findByText('旧接线参考');

    // 把参考边 探针1→座4（[0][3]=60）设为禁配
    const cell60 = Array.from(container.querySelectorAll('.cell-value')).find(
      (b) => b.textContent === '60'
    );
    fireEvent.click(cell60);
    const input = container.querySelector('.cell-input');
    fireEvent.change(input, { target: { value: 'x' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    // 参考面板该行出现“已禁配”标记
    expect(container.querySelectorAll('.ref-chip.ref-forbidden')).toHaveLength(1);
    expect(container.textContent).toContain('已禁配');

    fireEvent.click(getByText('迁移求解（少改线）'));
    await findByText('迁移方案（同成本最少改线）');
    // 行0离开已禁配旧列3，行3随之让列：变更行 0、3
    expect(container.querySelectorAll('.pair.changed')).toHaveLength(2);
    expect(getByText('由座 4 改配')).toBeTruthy();
    expect(getByText('由座 3 改配')).toBeTruthy();
  });

  it('迁移方案下“排除此配对”：仍带同一参考重算，标记重新分析', async () => {
    const bodies = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url, init) => {
        const body = JSON.parse(init.body);
        bodies.push(body);
        if (!body.reference) return okPlain([3, 0, 1, 2], 205);
        const excluded = body.costs[0][3] === null;
        if (!excluded) return okMigration([3, 0, 1, 2], 205, body.reference, []);
        // 排除后新配对 [2,0,1,3]，行0/3 变更，全部必然（替代问题的新分析）
        return jsonResponse(200, {
          status: 'ok',
          n: 4,
          assignment: [2, 0, 1, 3],
          totalCost: 295,
          pairFlags: [
            { forced: true, alternatives: 0 },
            { forced: true, alternatives: 0 },
            { forced: true, alternatives: 0 },
            { forced: true, alternatives: 0 },
          ],
          reference: body.reference,
          changedRows: [0, 3],
          changedCount: 2,
        });
      })
    );
    const utils = render(<App />);
    const { getByText, getAllByText, findByText, container } = utils;
    await solveOnce(utils);
    fireEvent.click(getByText('固定当前配对为旧接线参考'));
    await findByText('旧接线参考');
    fireEvent.click(getByText('迁移求解（少改线）'));
    await findByText('迁移方案（同成本最少改线）');

    // 排除迁移方案第一对（探针1→座4）
    fireEvent.click(getAllByText('排除此配对')[0]);
    await findByText('295');

    // 排除后的重算仍是迁移请求（参考未丢、模式未退回普通求解）
    expect(bodies[2].reference).toEqual([3, 0, 1, 2]);
    expect(bodies[2].costs[0][3]).toBeNull();
    // 新结果是迁移方案，2 行变更且 4 条全新必然标记
    expect(container.querySelectorAll('.pair.changed')).toHaveLength(2);
    expect(container.querySelector('.pairs').querySelectorAll('.pair-flag.is-forced')).toHaveLength(4);
  });
});

describe('App 迁移：失败、迟到与不可复算响应', () => {
  it('迁移 422（参考非法）：无方案上屏，参考仍保留可修改后重试', async () => {
    // 页面固定的参考在客户端恒为合法排列；422 模拟服务端拒绝（如旧服务严格校验）
    vi.stubGlobal('fetch', async (url, init) => {
      const body = JSON.parse(init.body);
      if (body.reference) {
        return jsonResponse(422, {
          status: 'error',
          error: 'INVALID_INPUT',
          message: 'reference 中列 1 重复，不是合法排列',
        });
      }
      return okPlain();
    });
    const utils = render(<App />);
    const { getByText, findByText, container } = utils;
    await solveOnce(utils);
    fireEvent.click(getByText('固定当前配对为旧接线参考'));
    await findByText('旧接线参考');
    fireEvent.click(getByText('迁移求解（少改线）'));
    await findByText(/INVALID_INPUT/);
    // 失败：不展示可操作新接线
    expect(container.querySelector('.result')).toBeNull();
    expect(container.querySelectorAll('.pair')).toHaveLength(0);
    // 参考仍在（失败归属：参考保留）
    expect(container.querySelectorAll('.ref-chip')).toHaveLength(4);
  });

  it('迁移 409：清除方案但保留参考', async () => {
    vi.stubGlobal('fetch', async (url, init) => {
      const body = JSON.parse(init.body);
      if (body.reference) {
        return jsonResponse(409, {
          status: 'error',
          error: 'NO_PERFECT_ASSIGNMENT',
          message: '禁配关系下不存在覆盖全部探针与测试座的完美匹配',
        });
      }
      return okPlain();
    });
    const utils = render(<App />);
    const { getByText, findByText, queryByText, container } = utils;
    await solveOnce(utils);
    fireEvent.click(getByText('固定当前配对为旧接线参考'));
    await findByText('旧接线参考');
    fireEvent.click(getByText('迁移求解（少改线）'));
    await findByText(/NO_PERFECT_ASSIGNMENT/);
    expect(queryByText('迁移方案（同成本最少改线）')).toBeNull();
    expect(container.querySelector('.result')).toBeNull();
    // 参考保留
    expect(container.querySelectorAll('.ref-chip')).toHaveLength(4);
  });

  it('迁移响应回显参考与本次不一致（迟到/串台）：协议错误且不上屏', async () => {
    vi.stubGlobal('fetch', async (url, init) => {
      const body = JSON.parse(init.body);
      if (!body.reference) return okPlain();
      // 服务端回显了另一个参考（旧请求的迟到响应）
      return okMigration([3, 0, 1, 2], 205, [0, 1, 2, 3], []);
    });
    const utils = render(<App />);
    const { getByText, findByText, container } = utils;
    await solveOnce(utils);
    fireEvent.click(getByText('固定当前配对为旧接线参考'));
    await findByText('旧接线参考');
    fireEvent.click(getByText('迁移求解（少改线）'));
    await findByText(/PROTOCOL_ERROR/);
    expect(container.querySelector('.result')).toBeNull();
    expect(container.querySelectorAll('.cell.match-changed')).toHaveLength(0);
    expect(container.querySelectorAll('.ref-chip')).toHaveLength(4); // 参考不受影响
  });

  it('迁移响应变更行数无法按当前矩阵/参考复算：协议错误且不上屏', async () => {
    vi.stubGlobal('fetch', async (url, init) => {
      const body = JSON.parse(init.body);
      if (!body.reference) return okPlain();
      // assignment 与参考零差异，却声称 2 行变更
      return okMigration([3, 0, 1, 2], 205, body.reference, [0, 3]);
    });
    const utils = render(<App />);
    const { getByText, findByText, container } = utils;
    await solveOnce(utils);
    fireEvent.click(getByText('固定当前配对为旧接线参考'));
    await findByText('旧接线参考');
    fireEvent.click(getByText('迁移求解（少改线）'));
    await findByText(/PROTOCOL_ERROR/);
    expect(container.querySelector('.result')).toBeNull();
    expect(container.querySelectorAll('.pair')).toHaveLength(0);
  });

  it('迟到响应（旧请求晚于新请求返回）：旧结果被序号防护丢弃，不得上屏', async () => {
    const first = deferred(); // 先发出的请求 A，迟到
    const second = deferred(); // 后发出的请求 B
    let call = 0;
    vi.stubGlobal('fetch', () => {
      call += 1;
      return call === 1 ? first.promise : second.promise;
    });
    let actions;
    const utils = render(<App __inspect={(api) => (actions = api)} />);
    const { findByText, getByText, container } = utils;

    // 请求 A 发出并进入锁定
    fireEvent.click(getByText('求解最小分配'));
    await findByText('请求进行中：编辑已锁定，等待服务器返回精确最优方案……');
    expect(call).toBe(1);

    // 正常 UI 已锁定（禁用按钮无法再点）；模拟极端情况下的重复派发，
    // 经测试钩子在 A 未返回时再发起 B，使 B 成为“当前请求”。
    act(() => {
      actions.solve();
    });
    expect(call).toBe(2);

    // A 迟到返回：必须被整体丢弃（不上屏、不解除加载态、不报任何错误）
    await act(async () => {
      first.resolve(okPlain([3, 0, 1, 2], 205));
    });
    expect(container.querySelector('.result')).toBeNull();
    expect(container.textContent).not.toContain('最优分配方案');

    // B 正常返回：B 的结果上屏
    await act(async () => {
      second.resolve(okPlain([3, 0, 1, 2], 205));
    });
    await findByText('最优分配方案');
    expect(getByText('205')).toBeTruthy();
  });

  it('网络失败：不上屏任何方案，参考保留；随后合法响应可恢复', async () => {
    let call = 0;
    vi.stubGlobal('fetch', async () => {
      call += 1;
      if (call === 1) return okPlain();
      if (call === 2) throw new Error('Failed to fetch');
      return okMigration([3, 0, 1, 2], 205, [3, 0, 1, 2], []);
    });
    const utils = render(<App />);
    const { getByText, findByText, container } = utils;
    await solveOnce(utils);
    fireEvent.click(getByText('固定当前配对为旧接线参考'));
    await findByText('旧接线参考');

    fireEvent.click(getByText('迁移求解（少改线）'));
    await findByText(/NETWORK_ERROR/);
    expect(container.querySelector('.result')).toBeNull();
    expect(container.querySelectorAll('.ref-chip')).toHaveLength(4); // 参考保留

    // 再试一次，合法迁移响应正常上屏
    fireEvent.click(getByText('迁移求解（少改线）'));
    await findByText('迁移方案（同成本最少改线）');
    expect(container.querySelectorAll('.pair.kept')).toHaveLength(4);
  });
});

describe('App 迁移：清除参考与普通模式并存', () => {
  it('清除参考后迁移按钮禁用，普通求解仍可用且响应无迁移面板', async () => {
    vi.stubGlobal('fetch', async () => okPlain());
    const utils = render(<App />);
    const { getByText, findByText, queryByText, container } = utils;
    await solveOnce(utils);
    fireEvent.click(getByText('固定当前配对为旧接线参考'));
    await findByText('旧接线参考');

    fireEvent.click(getByText('清除参考'));
    expect(container.querySelector('.ref-panel')).toBeNull();
    expect(getByText('迁移求解（少改线）').closest('button').disabled).toBe(true);

    // 普通求解仍可用，标题不带“迁移”
    fireEvent.click(getByText('求解最小分配'));
    await findByText('最优分配方案');
    expect(queryByText('迁移方案（同成本最少改线）')).toBeNull();
  });

  it('重新固定：以当前配对整批替换旧参考（不叠加、不重复）', async () => {
    vi.stubGlobal('fetch', async () => okPlain());
    const utils = render(<App />);
    const { getByText, findByText, container } = utils;
    await solveOnce(utils);
    fireEvent.click(getByText('固定当前配对为旧接线参考'));
    await findByText('旧接线参考');
    // 按钮文案变为“重新固定…”
    expect(getByText('重新固定当前配对为参考')).toBeTruthy();
    // 再次点击即以当前配对（仍是 [3,0,1,2]）整批替换；面板仍是 4 个芯片，不叠加
    fireEvent.click(getByText('重新固定当前配对为参考'));
    expect(container.querySelectorAll('.ref-chip')).toHaveLength(4);
  });
});
