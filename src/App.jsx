import React, { useMemo, useState, useCallback, useRef } from 'react';
import MatrixGrid from './components/MatrixGrid.jsx';
import { validateSolveResponse } from './validateSolution.js';
import { validateMigrationResponse } from './validateMigration.js';

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
  // 普通求解：{ mode:'solve', assignment, totalCost, elapsedMs, pairFlags }
  // 迁移求解：{ mode:'migrate', assignment, totalCost, elapsedMs, changedRows }（无 pairFlags）
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null); // { status, code, message }
  const [excludedHint, setExcludedHint] = useState(null); // 刚刚排除的格
  // 旧接线参考：由“当前完整配对”固定而来的 0..n-1 排列；仅矩阵规模变化时清除，
  // 改代价/禁配格不清除（这正是迁移的使用方式）。
  const [reference, setReference] = useState(null);
  // 单调请求序号：只接受最新一次请求的响应；迟到（被后发请求覆盖）的响应整份丢弃，
  // 绝不上屏成为可操作接线。
  const reqSeqRef = useRef(0);

  // 编辑（改格、预设）立即清除旧方案与错误，但保留旧接线参考。
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
      // 页面改变矩阵规模时清除参考：旧排列对新规模已无意义。
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
      // 请求结束后的任何编辑立即清除旧方案（参考保留：迁移就是“改完再迁”）
      setResult(null);
      setError(null);
      setExcludedHint(null);
    },
    []
  );

  // 把当前完整配对固定为旧接线参考（普通方案/迁移方案均可）。
  const pinReference = useCallback(() => {
    if (result) setReference(result.assignment.slice());
  }, [result]);

  const clearReference = useCallback(() => {
    setReference(null);
  }, []);

  const solve = useCallback(async (costsOverride = null) => {
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
        body: JSON.stringify({ costs }),
      });
      if (seq !== reqSeqRef.current) return; // 迟到响应：整份丢弃，不展示任何方案
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
            mode: 'solve',
            assignment: verdict.assignment,
            totalCost: verdict.totalCost,
            elapsedMs: Math.round(performance.now() - started),
            pairFlags: verdict.pairFlags,
          });
        }
      } else {
        // 两类失败（422 / 409）都清除旧方案；参考保留以便重试迁移。
        setResult(null);
        setError({
          status: resp.status,
          code: data?.error || 'ERROR',
          message: data?.message || '求解失败',
        });
      }
    } catch (err) {
      if (seq !== reqSeqRef.current) return;
      setResult(null);
      setError({ status: 0, code: 'NETWORK_ERROR', message: `网络错误：${err.message}` });
    } finally {
      if (seq === reqSeqRef.current) setLoading(false);
    }
  }, [matrix]);

  // 迁移求解：携带旧接线参考，服务端先最小化新矩阵总成本，再最小化变更行数。
  const migrate = useCallback(
    async (costsOverride = null) => {
      const costs = costsOverride || matrix;
      if (!Array.isArray(reference) || reference.length !== costs.length) return;
      const seq = ++reqSeqRef.current;
      setLoading(true);
      setError(null);
      const started = performance.now();
      try {
        const resp = await fetch('/api/migrate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ costs, reference }),
        });
        if (seq !== reqSeqRef.current) return; // 迟到响应：整份丢弃
        const data = await resp.json().catch(() => null);
        if (resp.ok && data && data.status === 'ok') {
          // 迁移响应同样必须“属于当前矩阵 + 当前参考且可完整复算”：
          // 排列结构、禁配格、totalCost 复算、changedRows 复算、回显参考归属。
          const verdict = validateMigrationResponse(data, costs, reference);
          if (!verdict.ok) {
            setResult(null);
            setError({
              status: resp.status,
              code: 'PROTOCOL_ERROR',
              message: `迁移响应未通过校验：${verdict.reason}`,
            });
          } else {
            // 迁移模式不携带也不沿用任何必然标记。
            setResult({
              mode: 'migrate',
              assignment: verdict.assignment,
              totalCost: verdict.totalCost,
              changedRows: verdict.changedRows,
              elapsedMs: Math.round(performance.now() - started),
            });
          }
        } else {
          // 失败：不展示可操作的新接线；旧接线参考保留，可改矩阵后重试。
          setResult(null);
          setError({
            status: resp.status,
            code: data?.error || 'ERROR',
            message: data?.message || '迁移求解失败',
          });
        }
      } catch (err) {
        if (seq !== reqSeqRef.current) return;
        setResult(null);
        setError({ status: 0, code: 'NETWORK_ERROR', message: `网络错误：${err.message}` });
      } finally {
        if (seq === reqSeqRef.current) setLoading(false);
      }
    },
    [matrix, reference]
  );

  // 排除方案中的一个配对：该格设为禁配（null），按当前方案所属模式经同一接口立即重算。
  const excludePair = useCallback(
    async (i, j) => {
      setExcludedHint({ i, j });
      const next = matrix.slice();
      next[i] = matrix[i].slice();
      next[i][j] = null;
      setMatrix(next);
      setResult(null);
      setError(null);
      if (result && result.mode === 'migrate' && reference) {
        await migrate(next);
      } else {
        await solve(next);
      }
    },
    [matrix, solve, migrate, result, reference]
  );

  const matchedSet = useMemo(() => {
    if (!result) return null;
    const s = new Set();
    result.assignment.forEach((j, i) => s.add(i * n + j));
    return s;
  }, [result, n]);

  // 旧接线参考占用格（独立于本次方案，用于格上蓝框提示）。
  const referenceSet = useMemo(() => {
    if (!reference) return null;
    const s = new Set();
    reference.forEach((j, i) => s.add(i * n + j));
    return s;
  }, [reference, n]);

  // 参考线在当前矩阵中已被禁配的行数（仍可计算变更数，但必然要改）。
  const referenceForbiddenCount = useMemo(() => {
    if (!reference) return 0;
    let c = 0;
    reference.forEach((j, i) => {
      if (matrix[i] && matrix[i][j] === null) c++;
    });
    return c;
  }, [reference, matrix]);

  // 每个展示配对的标记（key=i*n+j）：
  // 普通求解：'forced' | 'flexible'（来自同次响应的 pairFlags）；
  // 迁移求解：'kept' | 'changed'（相对参考逐行比较，不沿用必然标记）。
  const matchedMarks = useMemo(() => {
    if (!result) return null;
    const m = new Map();
    if (result.mode === 'migrate') {
      if (!reference) return null;
      result.assignment.forEach((j, i) => {
        m.set(i * n + j, j === reference[i] ? 'kept' : 'changed');
      });
      return m;
    }
    if (!result.pairFlags) return null;
    result.assignment.forEach((j, i) => {
      const flag = result.pairFlags[i];
      m.set(i * n + j, flag && flag.forced === true ? 'forced' : 'flexible');
    });
    return m;
  }, [result, reference, n]);

  const forcedCount = useMemo(() => {
    if (!result || result.mode !== 'solve' || !result.pairFlags) return 0;
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

  const isMigrate = result && result.mode === 'migrate';

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
          className="migrate-btn"
          onClick={() => migrate()}
          disabled={loading || !reference}
          title={reference ? '先最小化新矩阵总代价，再最小化相对旧接线参考的变更行数' : '请先把一组完整配对固定为旧接线参考'}
        >
          按参考迁移求解
        </button>
        <span className="meta">
          n = {n} · 禁配 {forbiddenCount} 格
        </span>
      </section>

      {reference && (
        <section className="reference-panel" data-testid="reference-panel">
          <div className="reference-head">
            <strong>旧接线参考</strong>
            <span className="meta">
              n = {reference.length}
              {referenceForbiddenCount > 0 && ` · ${referenceForbiddenCount} 条旧线在新矩阵中已禁配（必改）`}
            </span>
            <button className="link-btn" onClick={clearReference} disabled={loading}>
              清除旧接线参考
            </button>
          </div>
          <div className="reference-chips">
            {reference.map((j, i) => {
              const forbidden = matrix[i] && matrix[i][j] === null;
              return (
                <span
                  key={i}
                  className={`ref-chip ${forbidden ? 'ref-forbidden' : ''}`}
                  title={forbidden ? `探针 ${i + 1} → 座 ${j + 1} 在新矩阵中已禁配` : undefined}
                >
                  {i + 1}→{j + 1}
                </span>
              );
            })}
          </div>
        </section>
      )}

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

      {result && !isMigrate && (
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
              <button className="pin-btn" onClick={pinReference} disabled={loading}>
                固定当前配对为旧接线参考
              </button>
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

      {result && isMigrate && (
        <section className="result migrate-result" data-testid="migrate-result">
          <div className="result-head">
            <h2>迁移方案</h2>
            <div className="totals">
              <span>
                最小总代价：<strong>{result.totalCost.toLocaleString('zh-CN')}</strong>
              </span>
              <span className="recompute" data-ok={recomputed.ok}>
                本地复算：{recomputed.sum === null ? '存在禁配格 ✗' : recomputed.sum.toLocaleString('zh-CN')}{' '}
                {recomputed.ok ? '✓ 与服务器一致' : '✗ 不一致'}
              </span>
              <span className="changed-summary" data-testid="changed-summary">
                相对旧接线参考变更 <strong>{result.changedRows}</strong> / {n} 行
              </span>
              <span className="meta">耗时 {result.elapsedMs} ms</span>
              <button className="pin-btn" onClick={pinReference} disabled={loading}>
                固定当前配对为旧接线参考
              </button>
            </div>
          </div>
          <div className="pairs">
            {result.assignment.map((j, i) => {
              const kept = reference && j === reference[i];
              return (
                <div
                  key={i}
                  className={`pair ${kept ? 'kept' : 'changed'} ${
                    excludedHint && excludedHint.i === i && excludedHint.j === j ? 'just-excluded' : ''
                  }`}
                >
                  <span className="pair-label">
                    探针 {i + 1} → 座 {j + 1}
                  </span>
                  <span className="pair-cost">{matrix[i][j]?.toLocaleString('zh-CN')}</span>
                  <span
                    className={`migrate-flag ${kept ? 'is-kept' : 'is-changed'}`}
                    title={
                      kept
                        ? '保持旧线：与旧接线参考一致，不产生改动'
                        : '改线：为达到最小总代价，该探针改配其他测试座'
                    }
                  >
                    {kept ? '保持旧线' : `改线（原座 ${reference[i] + 1}）`}
                  </span>
                  <button
                    className="exclude"
                    disabled={loading}
                    title="把该格设为禁配并按同一旧接线参考重新迁移"
                    onClick={() => excludePair(i, j)}
                  >
                    排除此配对
                  </button>
                </div>
              );
            })}
          </div>
          <p className="flags-legend">
            <span className="legend-item">
              <i className="dot kept-dot" /> 保持旧线
            </span>
            ：与旧接线参考逐行一致，不计改动；
            <span className="legend-item">
              <i className="dot changed-dot" /> 改线
            </span>
            ：共 {result.changedRows} 行探针改配（总代价已是新矩阵最小值，同成本方案中改动最少）。
            迁移模式不标注必然/可替换；旧接线中的已禁配格以参考面板标记为准。
          </p>
        </section>
      )}

      <section className="grid-section">
        <MatrixGrid
          n={n}
          matrix={matrix}
          matchedSet={matchedSet}
          matchedMarks={matchedMarks}
          referenceSet={referenceSet}
          locked={loading}
          excludedHint={excludedHint}
          onEdit={editCell}
        />
      </section>
    </div>
  );
}
