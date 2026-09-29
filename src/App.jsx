import React, { useMemo, useState, useCallback, useRef } from 'react';
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

export default function App({ __inspect }) {
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
  // { assignment, totalCost, elapsedMs, pairFlags: [{forced, alternatives}] | null,
  //   migration: { reference, changedRows, changedCount } | null }
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null); // { status, code, message }
  const [excludedHint, setExcludedHint] = useState(null); // 刚刚排除的格
  // 旧接线参考：上一批已核准的完整配对（长度 n 的列下标排列）或 null。
  // 仅在矩阵规模改变时清除；改格、禁配、预设、同规模重算都保留它。
  const [reference, setReference] = useState(null);
  // 请求序号：迟到响应（旧请求晚于新请求返回）一律丢弃，绝不上屏。
  const reqSeqRef = useRef(0);

  // 编辑（尺寸变化、改格、预设）都会立即清除旧方案与错误。
  const clearPlan = useCallback(() => {
    setResult(null);
    setError(null);
    setExcludedHint(null);
  }, []);

  const applySize = () => {
    const next = Number(nInput);
    if (Number.isInteger(next) && next >= 1 && next <= MAX_N && next !== n) {
      setN(next);
      setMatrix((old) => buildMatrix(next, old));
      // 页面改变矩阵规模时清除旧接线参考（排列维度不再匹配）。
      setReference(null);
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
      // 请求结束后的任何编辑立即清除旧方案（参考保留：规模未变，仍可发起迁移）
      setResult(null);
      setError(null);
      setExcludedHint(null);
    },
    []
  );

  // useReference：本次请求携带的旧接线参考（数组=迁移模式，null=普通求解）。
  const solve = useCallback(
    async (costsOverride = null, useReference = null) => {
      const costs = costsOverride || matrix;
      const seq = ++reqSeqRef.current;
      setLoading(true);
      // 请求期间锁定编辑与提交：界面禁用，状态冻结
      setError(null);
      const started = performance.now();
      try {
        const resp = await fetch('/api/solve', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(useReference ? { costs, reference: useReference } : { costs }),
        });
        // 迟到响应防护：期间已有更新的请求发出时，本次结果（无论成败）整体丢弃，
        // 不允许覆盖/复活任何方案。
        if (seq !== reqSeqRef.current) return;
        const data = await resp.json().catch(() => null);
        if (resp.ok && data && data.status === 'ok') {
          // 成功响应也要先过校验（代理/缓存/滚动升级中的旧服务都可能返回
          // 不属于当前矩阵或无法复算的数据）：身份 n、assignment 排列结构、
          // 禁配格、totalCost 精确复算、pairFlags 与本次配对完整对应；
          // 迁移模式还要核对回显参考与 changedRows 归属。
          // 任何一项不合格都不得成为可操作方案：清除旧方案与旧高亮，报协议错误。
          const verdict = validateSolveResponse(data, costs, useReference);
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
              migration: verdict.migration,
            });
          }
        } else {
          // 两类失败（422 / 409）都清除旧方案；失败不清参考，仍可改后重试迁移。
          setResult(null);
          setError({
            status: resp.status,
            code: data?.error || 'ERROR',
            message: data?.message || '求解失败',
          });
        }
      } catch (err) {
        if (seq !== reqSeqRef.current) return; // 网络失败的迟到响应同样丢弃
        setResult(null);
        setError({ status: 0, code: 'NETWORK_ERROR', message: `网络错误：${err.message}` });
      } finally {
        if (seq === reqSeqRef.current) setLoading(false);
      }
    },
    [matrix]
  );

  // 把当前完整配对固定为“旧接线参考”；再次固定即以当前配对整批替换旧参考。
  // 按钮只在有方案时渲染，这里闭包读取当前 result 即可。
  const pinReference = useCallback(() => {
    if (result) setReference(result.assignment.slice());
  }, [result]);

  const clearReference = useCallback(() => setReference(null), []);

  // 排除方案中的一个配对：该格设为禁配（null），经同一接口立即重算。
  // 迁移方案下排除仍沿用上轮参考（不退回普通模式，也不沿用旧方案的必然标记）。
  const excludePair = useCallback(
    async (i, j) => {
      const modeReference = result && result.migration ? result.migration.reference : null;
      setExcludedHint({ i, j });
      const next = matrix.slice();
      next[i] = matrix[i].slice();
      next[i][j] = null;
      setMatrix(next);
      setResult(null);
      setError(null);
      await solve(next, modeReference);
    },
    [matrix, solve, result]
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

  // 迁移模式的变更归属（key=i*n+j → 'changed' | 'kept'）：
  // 变更行=新配对列与参考不同；保留行=与参考完全一致。只针对当前展示配对。
  const migrationMarks = useMemo(() => {
    if (!result || !result.migration) return null;
    const changed = new Set(result.migration.changedRows);
    const m = new Map();
    result.assignment.forEach((j, i) => m.set(i * n + j, changed.has(i) ? 'changed' : 'kept'));
    return m;
  }, [result, n]);

  const changedRowSet = useMemo(
    () => (result && result.migration ? new Set(result.migration.changedRows) : null),
    [result]
  );

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

  // 仅供测试的内部动作出口：生产代码不传 __inspect，行为零差异。
  // 用于模拟 UI 锁定期间的极端重复派发（验证迟到响应序号防护）等无法经禁用按钮触发的场景。
  const inspectRef = useRef(null);
  inspectRef.current = {
    solve: (costsOverride = null, useReference = null) => solve(costsOverride, useReference),
  };
  if (typeof __inspect === 'function') __inspect(inspectRef.current);

  const forbiddenCount = useMemo(() => {
    let c = 0;
    for (const row of matrix) for (const v of row) if (v === null) c++;
    return c;
  }, [matrix]);

  // 固定的参考是否还能对当前规模发起迁移（规模改变时参考已被清除，正常恒为 true）。
  const referenceReady = reference !== null && reference.length === n;

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
        <button
          className="migrate"
          onClick={() => solve(null, reference)}
          disabled={loading || !referenceReady}
          title={
            referenceReady
              ? '先最小化新矩阵总成本，再在同成本最优匹配中尽量保留旧接线'
              : '请先在某个方案上点“固定为旧接线参考”'
          }
        >
          迁移求解（少改线）
        </button>
        <span className="meta">
          n = {n} · 禁配 {forbiddenCount} 格
          {referenceReady ? ` · 已固定旧接线参考（${reference.length} 对）` : ''}
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

      {referenceReady && (
        <section className="ref-panel" aria-label="旧接线参考">
          <div className="ref-head">
            <strong>旧接线参考</strong>
            <span className="meta">
              上一批已核准的 {reference.length} 对配对；迁移时优先保留，规模改变即清除
            </span>
            <button className="ref-clear" onClick={clearReference} disabled={loading}>
              清除参考
            </button>
          </div>
          <div className="ref-pairs">
            {reference.map((j, i) => {
              const nowForbidden = matrix[i][j] === null;
              return (
                <span
                  key={i}
                  className={`ref-chip ${nowForbidden ? 'ref-forbidden' : ''}`}
                  title={
                    nowForbidden
                      ? `探针 ${i + 1} → 座 ${j + 1}：该参考边在新矩阵中已禁配，迁移时此行必然变更`
                      : `探针 ${i + 1} → 座 ${j + 1}，新矩阵当前代价 ${matrix[i][j]}`
                  }
                >
                  {i + 1}→{j + 1}
                  {nowForbidden && <em className="ref-tag">已禁配</em>}
                </span>
              );
            })}
          </div>
        </section>
      )}

      {result && (
        <section className="result">
          <div className="result-head">
            <h2>{result.migration ? '迁移方案（同成本最少改线）' : '最优分配方案'}</h2>
            <div className="totals">
              <span>
                最小总代价：<strong>{result.totalCost.toLocaleString('zh-CN')}</strong>
              </span>
              <span className="recompute" data-ok={recomputed.ok}>
                本地复算：{recomputed.sum === null ? '存在禁配格 ✗' : recomputed.sum.toLocaleString('zh-CN')}{' '}
                {recomputed.ok ? '✓ 与服务器一致' : '✗ 不一致'}
              </span>
              <span className="meta">耗时 {result.elapsedMs} ms</span>
              <button className="pin-ref" onClick={pinReference} disabled={loading}>
                {referenceReady ? '重新固定当前配对为参考' : '固定当前配对为旧接线参考'}
              </button>
            </div>
          </div>
          <div className="pairs">
            {result.assignment.map((j, i) => {
              const flag = result.pairFlags ? result.pairFlags[i] : null;
              const forced = flag && flag.forced === true;
              const alternatives = flag ? Number(flag.alternatives) || 0 : 0;
              const isChanged = changedRowSet ? changedRowSet.has(i) : false;
              const oldJ = result.migration ? result.migration.reference[i] : null;
              return (
                <div
                  key={i}
                  className={`pair ${flag ? (forced ? 'forced' : 'flexible') : ''} ${
                    result.migration ? (isChanged ? 'changed' : 'kept') : ''
                  } ${
                    excludedHint && excludedHint.i === i && excludedHint.j === j ? 'just-excluded' : ''
                  }`}
                >
                  <span className="pair-label">
                    探针 {i + 1} → 座 {j + 1}
                  </span>
                  <span className="pair-cost">{matrix[i][j]?.toLocaleString('zh-CN')}</span>
                  {result.migration && isChanged && (
                    <span className="change-badge" title={`旧接线为 探针 ${i + 1} → 座 ${oldJ + 1}`}>
                      由座 {oldJ + 1} 改配
                    </span>
                  )}
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
          {result.migration && (
            <p className="migration-legend">
              <span className="legend-item">
                <i className="dot changed-dot" /> 变更行
              </span>
              ：相对旧接线参考改配的探针，共 <strong>{result.migration.changedCount}</strong> 行
              {result.migration.changedCount > 0 && (
                <span className="changed-rows">
                  （探针 {result.migration.changedRows.map((r) => r + 1).join('、')}）
                </span>
              )}
              ；
              <span className="legend-item">
                <i className="dot kept-dot" /> 保留行
              </span>
              ：与参考完全一致。总代价不高于任何可行匹配；必然/可替换标记针对本次新配对重新分析，不沿用旧接线结论。
            </p>
          )}
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
          migrationMarks={migrationMarks}
          locked={loading}
          excludedHint={excludedHint}
          onEdit={editCell}
        />
      </section>
    </div>
  );
}
