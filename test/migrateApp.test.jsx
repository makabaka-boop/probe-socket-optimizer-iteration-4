// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, fireEvent, act, cleanup, waitFor } from '@testing-library/react';
import React from 'react';
import App from '../src/App.jsx';

// 页面迁移流程：固定旧接线参考 → 编辑代价/禁配 → 迁移求解（两级目标），
// 核对编辑、排除、失败/迟到/不可复算后的参考与结果归属。
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

const DEFAULT_4X4 = [
  [90, 75, 120, 60],
  [35, 80, 55, 200],
  [110, 40, 95, 130],
  [65, 150, 70, 100],
];

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

function solveOk(assignment, totalCost, pairFlags) {
  return jsonResponse(200, { status: 'ok', n: 4, assignment, totalCost, pairFlags });
}

function migrateOk({ assignment, totalCost, changedRows, reference }) {
  return jsonResponse(200, {
    status: 'ok',
    mode: 'migrate',
    n: 4,
    assignment,
    totalCost,
    changedRows,
    reference,
  });
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// 完整走一遍：普通求解 → 固定参考。返回工具与固定时所用的配对/费用。
async function solveAndPin(utils, { assignment = [3, 0, 1, 2], totalCost = 205 } = {}) {
  const { getByText, findByText } = utils;
  fireEvent.click(getByText('求解最小分配'));
  await findByText('最优分配方案');
  fireEvent.click(getByText('固定当前配对为旧接线参考'));
  await findByText('旧接线参考');
  return { pinnedAssignment: assignment, pinnedTotal: totalCost };
}

describe('App 迁移：固定旧接线参考', () => {
  it('无方案时不能迁移；固定后参考面板出现，编辑代价/禁配不清除参考', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => solveOk([3, 0, 1, 2], 205)));
    const utils = render(<App />);
    const { getByText, findByText, queryByText, container } = utils;

    // 尚未固定参考：迁移按钮禁用
    expect(getByText('按参考迁移求解').closest('button').disabled).toBe(true);
    expect(queryByText('旧接线参考')).toBeNull();

    await solveAndPin(utils);
    // 参考面板：4 个参考格芯片
    expect(container.querySelectorAll('.ref-chip')).toHaveLength(4);
    // 矩阵上的旧线格有紫框
    expect(container.querySelectorAll('.cell.reference-cell').length).toBeGreaterThan(0);

    // 改一个代价格：方案清除，但参考保留
    const cell90 = Array.from(container.querySelectorAll('.cell-value')).find(
      (b) => b.textContent === '90'
    );
    fireEvent.click(cell90);
    const input = container.querySelector('.cell-input');
    fireEvent.change(input, { target: { value: '123' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(queryByText('最优分配方案')).toBeNull();
    expect(queryByText('旧接线参考')).toBeTruthy();
    expect(getByText('按参考迁移求解').closest('button').disabled).toBe(false);
  });

  it('改变矩阵规模：参考与面板一并清除，迁移按钮重新禁用', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => solveOk([3, 0, 1, 2], 205)));
    const utils = render(<App />);
    const { getByText, findByText, queryByText, getByDisplayValue } = utils;
    await solveAndPin(utils);

    fireEvent.change(getByDisplayValue('4'), { target: { value: '3' } });
    fireEvent.click(getByText('应用'));
    expect(queryByText('旧接线参考')).toBeNull();
    expect(getByText('按参考迁移求解').closest('button').disabled).toBe(true);
  });

  it('“清除旧接线参考”只清参考，不影响矩阵', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => solveOk([3, 0, 1, 2], 205)));
    const utils = render(<App />);
    const { getByText, findByText, queryByText, container } = utils;
    await solveAndPin(utils);
    fireEvent.click(getByText('清除旧接线参考'));
    expect(queryByText('旧接线参考')).toBeNull();
    expect(container.querySelectorAll('.cell.reference-cell')).toHaveLength(0);
    // 矩阵格内容仍在
    expect(Array.from(container.querySelectorAll('.cell-value')).some((b) => b.textContent === '90')).toBe(true);
  });
});

describe('App 迁移：发起迁移与结果展示', () => {
  it('迁移请求携带 costs 与 reference，命中 /api/migrate；展示新配对、费用与变更行', async () => {
    const bodies = [];
    const fetchMock = vi.fn(async (url, init) => {
      const body = JSON.parse(init.body);
      bodies.push({ url, body });
      if (url === '/api/solve') return solveOk([3, 0, 1, 2], 205);
      return migrateOk({
        assignment: [3, 0, 1, 2],
        totalCost: 205,
        changedRows: 0,
        reference: body.reference,
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    const utils = render(<App />);
    const { getByText, findByText, container } = utils;
    await solveAndPin(utils);

    fireEvent.click(getByText('按参考迁移求解'));
    await findByText('迁移方案');

    // 请求归属：第二次打到 /api/migrate，载荷带 reference
    expect(bodies[1].url).toBe('/api/migrate');
    expect(bodies[1].body.reference).toEqual([3, 0, 1, 2]);
    expect(bodies[1].body.costs).toEqual(DEFAULT_4X4);
    // 0 变更：4 条全部“保持旧线”
    expect(getByText(/变更/).textContent).toContain('0');
    expect(container.querySelectorAll('.migrate-flag.is-kept')).toHaveLength(4);
    expect(container.querySelectorAll('.migrate-flag.is-changed')).toHaveLength(0);
    expect(container.querySelectorAll('.cell.match-kept')).toHaveLength(4);
    // 迁移模式不出现必然/可替换标记
    expect(container.querySelectorAll('.pair-flag')).toHaveLength(0);
    expect(container.querySelectorAll('.cell.match-forced')).toHaveLength(0);
    // 本地复算一致
    expect(getByText(/✓ 与服务器一致/)).toBeTruthy();
  });

  it('同成本并列时展示最小变更：4 行全改的合法迁移正确标注改线与原座', async () => {
    const refId = [0, 1, 2, 3];
    const fetchMock = vi.fn(async (url, init) => {
      const body = JSON.parse(init.body);
      if (url === '/api/solve') return solveOk(refId, 365); // 把恒等排列当作已核准旧线固定
      return migrateOk({
        assignment: [3, 0, 1, 2],
        totalCost: 205,
        changedRows: 4,
        reference: body.reference,
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    const utils = render(<App />);
    const { getByText, findByText, container } = utils;
    await solveAndPin(utils, { assignment: refId, totalCost: 365 });

    fireEvent.click(getByText('按参考迁移求解'));
    await findByText('迁移方案');
    expect(container.querySelectorAll('.migrate-flag.is-changed')).toHaveLength(4);
    expect(container.querySelectorAll('.cell.match-changed')).toHaveLength(4);
    // 每张卡片注明改到哪个原座
    expect(getByText('改线（原座 1）')).toBeTruthy();
    expect(getByText(/共 4 行探针改配/)).toBeTruthy();
  });

  it('迁移结果可再次固定为新的旧接线参考', async () => {
    const fetchMock = vi.fn(async (url, init) => {
      const body = JSON.parse(init.body);
      if (url === '/api/solve') return solveOk([0, 1, 2, 3], 365);
      return migrateOk({
        assignment: [3, 0, 1, 2],
        totalCost: 205,
        changedRows: 4,
        reference: body.reference,
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    const utils = render(<App />);
    const { getByText, findByText, container } = utils;
    await solveAndPin(utils, { assignment: [0, 1, 2, 3], totalCost: 365 });
    fireEvent.click(getByText('按参考迁移求解'));
    await findByText('迁移方案');

    // 迁移方案区也能固定；固定后参考芯片更新为新配对
    const pinButtons = getAllPinButtons(container);
    fireEvent.click(pinButtons[pinButtons.length - 1]);
    const chips = Array.from(container.querySelectorAll('.ref-chip')).map((e) => e.textContent);
    expect(chips).toEqual(['1→4', '2→1', '3→2', '4→3']);
  });
});

function getAllPinButtons(container) {
  return Array.from(container.querySelectorAll('button')).filter(
    (b) => b.textContent === '固定当前配对为旧接线参考'
  );
}

describe('App 迁移：排除配对重迁', () => {
  it('排除迁移方案中的配对：该格禁配，带同一参考重迁，按新结果重算变更', async () => {
    const bodies = [];
    const fetchMock = vi.fn(async (url, init) => {
      const body = JSON.parse(init.body);
      bodies.push({ url, body });
      if (url === '/api/solve') return solveOk([3, 0, 1, 2], 205);
      // 迁移：未排除时 0 变更；排除 [0][3] 后 [0,2,1,3]，费用 285，变更 3
      const excluded = body.costs[0][3] === null;
      if (!excluded) {
        return migrateOk({ assignment: [3, 0, 1, 2], totalCost: 205, changedRows: 0, reference: body.reference });
      }
      return migrateOk({ assignment: [0, 2, 1, 3], totalCost: 285, changedRows: 3, reference: body.reference });
    });
    vi.stubGlobal('fetch', fetchMock);
    const utils = render(<App />);
    const { getByText, getAllByText, findByText, container } = utils;
    await solveAndPin(utils);
    fireEvent.click(getByText('按参考迁移求解'));
    await findByText('迁移方案');

    fireEvent.click(getAllByText('排除此配对')[0]);
    await findByText('285');
    // 仍是迁移端点、参考不变、被排格已禁配
    const migrates = bodies.filter((b) => b.url === '/api/migrate');
    expect(migrates).toHaveLength(2);
    expect(migrates[1].body.reference).toEqual([3, 0, 1, 2]);
    expect(migrates[1].body.costs[0][3]).toBeNull();
    // 新结果的标记整体重算：3 改 1 留，不残留上一轮的 0 变更徽标
    expect(container.querySelectorAll('.migrate-flag.is-changed')).toHaveLength(3);
    expect(container.querySelectorAll('.migrate-flag.is-kept')).toHaveLength(1);
    // 仍是迁移模式，没有必然标记
    expect(container.querySelectorAll('.pair-flag')).toHaveLength(0);
  });
});

describe('App 迁移：失败与不可复算不展示可操作接线', () => {
  it('迁移 409：清除新接线但保留参考，可修改后重试', async () => {
    const fetchMock = vi.fn(async (url) => {
      if (url === '/api/solve') return solveOk([3, 0, 1, 2], 205);
      return jsonResponse(409, {
        status: 'error',
        error: 'NO_PERFECT_ASSIGNMENT',
        message: '禁配关系下不存在覆盖全部探针与测试座的完美匹配',
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    const utils = render(<App />);
    const { getByText, findByText, queryByText, container } = utils;
    await solveAndPin(utils);
    fireEvent.click(getByText('按参考迁移求解'));
    await findByText(/NO_PERFECT_ASSIGNMENT/);
    // 不展示可操作新接线
    expect(queryByText('迁移方案')).toBeNull();
    expect(container.querySelectorAll('.exclude')).toHaveLength(0);
    // 参考保留
    expect(queryByText('旧接线参考')).toBeTruthy();
    expect(getByText('按参考迁移求解').closest('button').disabled).toBe(false);
  });

  it('迁移 422（参考非法）：报错且不展示接线', async () => {
    const fetchMock = vi.fn(async (url) => {
      if (url === '/api/solve') return solveOk([3, 0, 1, 2], 205);
      return jsonResponse(422, { status: 'error', error: 'INVALID_INPUT', message: 'reference 中列重复' });
    });
    vi.stubGlobal('fetch', fetchMock);
    const utils = render(<App />);
    const { getByText, findByText, queryByText } = utils;
    await solveAndPin(utils);
    fireEvent.click(getByText('按参考迁移求解'));
    await findByText(/INVALID_INPUT/);
    expect(queryByText('迁移方案')).toBeNull();
  });

  it('迁移网络失败：不展示接线、参考保留', async () => {
    const fetchMock = vi.fn(async (url) => {
      if (url === '/api/solve') return solveOk([3, 0, 1, 2], 205);
      throw new Error('Failed to fetch');
    });
    vi.stubGlobal('fetch', fetchMock);
    const utils = render(<App />);
    const { getByText, findByText, queryByText } = utils;
    await solveAndPin(utils);
    fireEvent.click(getByText('按参考迁移求解'));
    await findByText(/NETWORK_ERROR/);
    expect(queryByText('迁移方案')).toBeNull();
    expect(queryByText('旧接线参考')).toBeTruthy();
  });

  it('迁移响应无法按当前矩阵复算（totalCost 不符）：PROTOCOL_ERROR 且不展示', async () => {
    const fetchMock = vi.fn(async (url, init) => {
      const body = JSON.parse(init.body);
      if (url === '/api/solve') return solveOk([3, 0, 1, 2], 205);
      return migrateOk({ assignment: [3, 0, 1, 2], totalCost: 999, changedRows: 0, reference: body.reference });
    });
    vi.stubGlobal('fetch', fetchMock);
    const utils = render(<App />);
    const { getByText, findByText, queryByText, container } = utils;
    await solveAndPin(utils);
    fireEvent.click(getByText('按参考迁移求解'));
    await findByText(/PROTOCOL_ERROR/);
    expect(queryByText('迁移方案')).toBeNull();
    expect(container.querySelectorAll('.exclude')).toHaveLength(0);
    // 参考仍在，可重试
    expect(queryByText('旧接线参考')).toBeTruthy();
  });

  it('迁移响应 changedRows 与当前参考复算不符：拒绝上屏', async () => {
    const fetchMock = vi.fn(async (url, init) => {
      const body = JSON.parse(init.body);
      if (url === '/api/solve') return solveOk([3, 0, 1, 2], 205);
      // assignment 与参考完全一致却谎称 2 行变更
      return migrateOk({ assignment: [3, 0, 1, 2], totalCost: 205, changedRows: 2, reference: body.reference });
    });
    vi.stubGlobal('fetch', fetchMock);
    const utils = render(<App />);
    const { getByText, findByText, queryByText } = utils;
    await solveAndPin(utils);
    fireEvent.click(getByText('按参考迁移求解'));
    await findByText(/PROTOCOL_ERROR/);
    expect(queryByText('迁移方案')).toBeNull();
  });

  it('迁移响应回显的参考与当前参考不一致：拒绝上屏', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url) => {
        if (url === '/api/solve') return solveOk([3, 0, 1, 2], 205);
        return migrateOk({
          assignment: [3, 0, 1, 2],
          totalCost: 205,
          changedRows: 0,
          reference: [0, 1, 2, 3], // 与页面当前参考 [3,0,1,2] 不符
        });
      })
    );
    const utils = render(<App />);
    const { getByText, findByText, queryByText } = utils;
    await solveAndPin(utils);
    fireEvent.click(getByText('按参考迁移求解'));
    await findByText(/PROTOCOL_ERROR/);
    expect(queryByText('迁移方案')).toBeNull();
  });

  it('迟到的迁移响应被丢弃：先发出的迁移晚于后发迁移返回时，旧结果不得顶替', async () => {
    // 第一次迁移的响应挂起（迟到）；第二次迁移先返回。两次点击在 React 因 loading
    // 重渲染禁用按钮之前同步发出，各自获得严格递增的请求序号。
    const dFirst = deferred();
    let migrateCall = 0;
    const fetchMock = vi.fn(async (url, init) => {
      const body = JSON.parse(init.body);
      if (url === '/api/solve') return solveOk([3, 0, 1, 2], 205);
      migrateCall++;
      if (migrateCall === 1) return dFirst.promise; // 第一次迁移迟到
      return migrateOk({ assignment: [3, 0, 1, 2], totalCost: 205, changedRows: 0, reference: body.reference });
    });
    vi.stubGlobal('fetch', fetchMock);
    const utils = render(<App />);
    const { getByText, findByText, queryByText } = utils;
    await solveAndPin(utils);

    const migrateBtn = getByText('按参考迁移求解').closest('button');
    // 在同一次事件批处理中同步发出两次迁移请求（模拟快速重复提交 / 排除后立即再迁）：
    // 两个 onClick 在按钮因 loading 重渲染禁用前都执行，获得严格递增序号 k、k+1。
    await act(async () => {
      migrateBtn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      migrateBtn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });
    await waitFor(() => expect(migrateCall).toBe(2));

    // 第二次（序号最新）先返回并上屏
    await findByText('迁移方案');

    // 第一次的迟到响应此时才回来：序号过期，必须整份丢弃、不引发任何错误或闪烁
    await act(async () => {
      dFirst.resolve(
        migrateOk({ assignment: [3, 0, 1, 2], totalCost: 205, changedRows: 0, reference: [3, 0, 1, 2] })
      );
    });
    await Promise.resolve();
    expect(queryByText('迁移方案')).toBeTruthy();
    expect(queryByText(/PROTOCOL_ERROR/)).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(3); // 1 次 solve + 2 次 migrate，没有额外请求
  });
});

describe('App 迁移：参考旧线在新矩阵已禁配', () => {
  it('固定参考后把一条旧线格设为禁配：参考面板标注必改，迁移仍可成功并计入变更', async () => {
    const fetchMock = vi.fn(async (url, init) => {
      const body = JSON.parse(init.body);
      if (url === '/api/solve') return solveOk([3, 0, 1, 2], 205);
      // 旧线 [0][3]=60 已禁配；新最优 [0,2,1,3]=285，变更 3
      return migrateOk({ assignment: [0, 2, 1, 3], totalCost: 285, changedRows: 3, reference: body.reference });
    });
    vi.stubGlobal('fetch', fetchMock);
    const utils = render(<App />);
    const { getByText, findByText, queryByText, container } = utils;
    await solveAndPin(utils);

    // 把 探针1→座4（60）设为禁配
    const cell60 = Array.from(container.querySelectorAll('.cell-value')).find(
      (b) => b.textContent === '60'
    );
    fireEvent.click(cell60);
    const input = container.querySelector('.cell-input');
    fireEvent.change(input, { target: { value: 'x' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    // 参考保留且面板提示有旧线已禁配
    expect(queryByText('旧接线参考')).toBeTruthy();
    const forbiddenChip = container.querySelector('.ref-chip.ref-forbidden');
    expect(forbiddenChip).toBeTruthy();
    expect(forbiddenChip.textContent).toBe('1→4');

    fireEvent.click(getByText('按参考迁移求解'));
    await findByText('迁移方案');
    expect(getByText('285')).toBeTruthy();
    expect(container.querySelectorAll('.migrate-flag.is-changed')).toHaveLength(3);
  });
});
