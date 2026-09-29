import React, { useMemo, useState, useCallback } from 'react';
import MatrixGrid from './components/MatrixGrid.jsx';
import { validateSolveResponse } from './validateSolution.js';

const MAX_N = 400;
const MAX_COST = 1_000_000_000_000;

function buildMatrix(n, old = null) {
  const m = Array.from({ length: n }, (_, i) =>
    Array.from({ length: n }, (_, j) => (old && old[i] && old[i][j] !== undefined ? old[i][j] : null))
  );
  return m;
}

function randomMatrix(n, forbiddenRate = 0) {
  return Array.from({ length: n }, () =>
    Array.from({ length: n }, () =>
      forbiddenRate > 0 && Math.random() < forbiddenRate ? null : Math.floor(Math.random() * 10000)
    )
  );
}

export default function App() {
  const [nInput, setNInput] = useState('4');
  const [n, setN] = useState(4);
  const [matrix, setMatrix] = useState(() =>
    buildMatrix(4, [
      [90, 75, 120, 60],
      [35, 80, 55, 200],
      [110, 40, 95, 130],
      [65, 150, 70, 100],
    ])
  );
  const [loading, setLoading] = useState(false);
  // result 与分析标记同一次更新、同一次清除：
  // { assignment, totalCost, elapsedMs, pairFlags: [{forced, alternatives}] }
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null); // { status, code, message }
  const [excludedHint, setExcludedHint] = useState(null); // 刚刚排除的格

  // 编辑（尺寸变化、改格、预设）都会立即清除旧方案与错误。
  const clearPlan = useCallback(() => {
    setResult(null);
    setError(null);
    setExcludedHint(null);
  }, []);

  const applySize = () => {
    const next = Number(nInput);
    if (Number.isInteger(next) && next >= 1 && next <= MAX_N) {
      setN(next);
      setMatrix((old) => buildMatrix(next, old));
      clearPlan();
    }
  };

  const editCell = useCallback(
    (i, j, value) => {
      setMatrix((old) => {
        if (old[i][j] === value) return old;
        const copy = old.slice();
        copy[i] = old[i].slice();
        copy[i][j] = value;
        return copy;
      });
      // 请求结束后的任何编辑立即清除旧方案
      setResult(null);
      setError(null);
      setExcludedHint(null);
    },
    []
  );

  const solve = useCallback(async (costsOverride = null) => {
    const costs = costsOverride || matrix;
    setLoading(true);
    // 请求期间锁定编辑与提交：界面禁用，状态冻结
    setError(null);
    const started = performance.now();
    try {
      const resp = await fetch('/api/solve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ costs }),
      });
      const data = await resp.json().catch(() => null);
      if (resp.ok && data && data.status === 'ok') {
        // 成功响应也要先过校验（代理/缓存/滚动升级中的旧服务都可能返回
        // 不属于当前矩阵或无法复算的数据）：身份 n、assignment 排列结构、
        // 禁配格、totalCost 精确复算、pairFlags 与本次配对完整对应。
        // 任何一项不合格都不得成为可操作方案：清除旧方案与旧高亮，报协议错误。
        const verdict = validateSolveResponse(data, costs);
        if (!verdict.ok) {
          setResult(null);
          setError({
            status: resp.status,
            code: 'PROTOCOL_ERROR',
            message: `求解响应未通过校验：${verdict.reason}`,
          });
        } else {
          // pairFlags 为 null 表示旧版服务未提供标记：展示分配但不臆造标记。
          setResult({
            assignment: verdict.assignment,
            totalCost: verdict.totalCost,
            elapsedMs: Math.round(performance.now() - started),
            pairFlags: verdict.pairFlags,
          });
        }
      } else {
        // 两类失败（422 / 409）都清除旧方案
        setResult(null);
        setError({
          status: resp.status,
          code: data?.error || 'ERROR',
          message: data?.message || '求解失败',
        });
      }
    } catch (err) {
      setResult(null);
      setError({ status: 0, code: 'NETWORK_ERROR', message: `网络错误：${err.message}` });
    } finally {
      setLoading(false);
    }
  }, [matrix]);

  // 排除方案中的一个配对：该格设为禁配（null），经同一接口立即重算。
  const excludePair = useCallback(
    async (i, j) => {
      setExcludedHint({ i, j });
      const next = matrix.slice();
      next[i] = matrix[i].slice();
      next[i][j] = null;
      setMatrix(next);
      setResult(null);
      setError(null);
      await solve(next);
    },
    [matrix, solve]
  );

  const matchedSet = useMemo(() => {
    if (!result) return null;
    const s = new Set();
    result.assignment.forEach((j, i) => s.add(i * n + j));
    return s;
  }, [result, n]);

  // 每个展示配对的必然标记（key=i*n+j → 'forced' | 'flexible'）。
  // 只覆盖当前展示的配对，随 result 同生同灭，不跨输入/重算残留。
  const matchedMarks = useMemo(() => {
    if (!result || !result.pairFlags) return null;
    const m = new Map();
    result.assignment.forEach((j, i) => {
      const flag = result.pairFlags[i];
      m.set(i * n + j, flag && flag.forced === true ? 'forced' : 'flexible');
    });
    return m;
  }, [result, n]);

  const forcedCount = useMemo(() => {
    if (!result || !result.pairFlags) return 0;
    return result.pairFlags.reduce((acc, f) => acc + (f && f.forced === true ? 1 : 0), 0);
  }, [result]);

  // 用返回的配对对原始矩阵独立复算总和，精确核对服务端结果。
  const recomputed = useMemo(() => {
    if (!result) return null;
    let sum = 0;
    for (let i = 0; i < n; i++) {
      const j = result.assignment[i];
      const c = matrix[i][j];
      if (c === null) return { sum: null, ok: false };
      sum += c;
    }
    return { sum, ok: sum === result.totalCost };
  }, [result, matrix, n]);

  const forbiddenCount = useMemo(() => {
    let c = 0;
    for (const row of matrix) for (const v of row) if (v === null) c++;
    return c;
  }, [matrix]);

  return (
    <div className="app">
      <header className="topbar">
        <h1>芯片老化台 · 探针分配</h1>
        <p className="subtitle">
          最小权完美二分匹配（O(n³) 匈牙利算法）· 行为探针，列为测试座，空/✕ 为禁配
        </p>
      </header>

      <section className="controls">
        <label className="size-control">
          规模 n
          <input
            type="number"
            min="1"
            max={MAX_N}
            value={nInput}
            disabled={loading}
            onChange={(e) => setNInput(e.target.value)}
          />
          <button onClick={applySize} disabled={loading}>
            应用
          </button>
        </label>
        <button onClick={() => { setMatrix(buildMatrix(n)); clearPlan(); }} disabled={loading}>
          全部禁配
        </button>
        <button
          onClick={() => { setMatrix(randomMatrix(n, 0)); clearPlan(); }}
          disabled={loading}
        >
          随机稠密
        </button>
        <button
          onClick={() => { setMatrix(randomMatrix(n, 0.15)); clearPlan(); }}
          disabled={loading}
        >
          随机含禁配
        </button>
        <button className="primary" onClick={() => solve()} disabled={loading}>
          {loading ? '求解中…' : '求解最小分配'}
        </button>
        <span className="meta">
          n = {n} · 禁配 {forbiddenCount} 格
        </span>
      </section>

      {loading && (
        <div className="banner loading">
          请求进行中：编辑已锁定，等待服务器返回精确最优方案……
        </div>
      )}

      {error && (
        <div className={`banner error ${error.code === 'NO_PERFECT_ASSIGNMENT' ? 'conflict' : ''}`}>
          <strong>
            {error.code === 'NO_PERFECT_ASSIGNMENT'
              ? `409 NO_PERFECT_ASSIGNMENT（${error.status}）`
              : `${error.status || ''} ${error.code}`.trim()}
          </strong>
          <span>{error.message}</span>
          {excludedHint && error.code === 'NO_PERFECT_ASSIGNMENT' && (
            <span className="hint">
              （已排除探针 {excludedHint.i + 1} → 测试座 {excludedHint.j + 1}，该替代问题无完美匹配）
            </span>
          )}
        </div>
      )}

      {result && (
        <section className="result">
          <div className="result-head">
            <h2>最优分配方案</h2>
            <div className="totals">
              <span>
                最小总代价：<strong>{result.totalCost.toLocaleString('zh-CN')}</strong>
              </span>
              <span className="recompute" data-ok={recomputed.ok}>
                本地复算：{recomputed.sum === null ? '存在禁配格 ✗' : recomputed.sum.toLocaleString('zh-CN')}{' '}
                {recomputed.ok ? '✓ 与服务器一致' : '✗ 不一致'}
              </span>
              <span className="meta">耗时 {result.elapsedMs} ms</span>
            </div>
          </div>
          <div className="pairs">
            {result.assignment.map((j, i) => {
              const flag = result.pairFlags ? result.pairFlags[i] : null;
              const forced = flag && flag.forced === true;
              const alternatives = flag ? Number(flag.alternatives) || 0 : 0;
              return (
                <div
                  key={i}
                  className={`pair ${flag ? (forced ? 'forced' : 'flexible') : ''} ${
                    excludedHint && excludedHint.i === i && excludedHint.j === j ? 'just-excluded' : ''
                  }`}
                >
                  <span className="pair-label">
                    探针 {i + 1} → 座 {j + 1}
                  </span>
                  <span className="pair-cost">{matrix[i][j]?.toLocaleString('zh-CN')}</span>
                  {flag && (
                    <span
                      className={`pair-flag ${forced ? 'is-forced' : 'is-flexible'}`}
                      title={
                        forced
                          ? '必然连线：在每一个同价最优方案中，该探针都只能配该测试座'
                          : `可替换：存在其他最优方案把该探针改配（本探针在最优解中有 ${alternatives} 条可替换连线）`
                      }
                    >
                      {forced ? '必然连线' : `可替换 ×${alternatives}`}
                    </span>
                  )}
                  <button
                    className="exclude"
                    disabled={loading}
                    title="把该格设为禁配并重新求解替代最优方案"
                    onClick={() => excludePair(i, j)}
                  >
                    排除此配对
                  </button>
                </div>
              );
            })}
          </div>
          {result.pairFlags && (
            <p className="flags-legend">
              <span className="legend-item">
                <i className="dot forced-dot" /> 必然连线
              </span>
              ：所有同价最优方案都必须采用，不可替换；
              <span className="legend-item">
                <i className="dot flexible-dot" /> 可替换
              </span>
              ：存在别的最优方案把该探针改配，×N 为可替换连线数（共 {forcedCount} 条必然 /{' '}
              {n - forcedCount} 条可替换）。标记只针对当前展示方案，排除配对或编辑后随重算更新。
            </p>
          )}
        </section>
      )}

      <section className="grid-section">
        <MatrixGrid
          n={n}
          matrix={matrix}
          matchedSet={matchedSet}
          matchedMarks={matchedMarks}
          locked={loading}
          excludedHint={excludedHint}
          onEdit={editCell}
        />
      </section>
    </div>
  );
}
