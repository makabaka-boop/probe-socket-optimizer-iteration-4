import React, { useEffect, useLayoutEffect, useRef, useState, useCallback } from 'react';

const CELL = 38;       // 数据格边长 px
const HEAD = 46;       // 行/列表头宽度/高度 px
const OVERSCAN = 4;    // 视口外预渲染格数

// 只渲染可视区域内的格子（n=400 时约几百个），表头跟随滚动平移。
export default function MatrixGrid({ n, matrix, matchedSet, matchedMarks, locked, excludedHint, onEdit }) {
  const scrollRef = useRef(null);
  const [scroll, setScroll] = useState({ top: 0, left: 0 });
  const [viewport, setViewport] = useState({ w: 0, h: 0 });
  const rafRef = useRef(0);

  const contentW = HEAD + n * CELL;
  const contentH = HEAD + n * CELL;

  const measure = useCallback(() => {
    const el = scrollRef.current;
    if (el) setViewport({ w: el.clientWidth, h: el.clientHeight });
  }, []);

  useLayoutEffect(() => {
    measure();
    const ro = new ResizeObserver(measure);
    if (scrollRef.current) ro.observe(scrollRef.current);
    return () => ro.disconnect();
  }, [measure]);

  useEffect(() => {
    // 尺寸变化后回到左上角
    setScroll({ top: 0, left: 0 });
    if (scrollRef.current && typeof scrollRef.current.scrollTo === 'function') {
      scrollRef.current.scrollTo(0, 0);
    }
  }, [n]);

  const onScroll = (e) => {
    const el = e.currentTarget;
    cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(() => {
      setScroll({ top: el.scrollTop, left: el.scrollLeft });
    });
  };

  const c0 = Math.max(0, Math.floor(scroll.left / CELL) - OVERSCAN);
  const r0 = Math.max(0, Math.floor(scroll.top / CELL) - OVERSCAN);
  const c1 = Math.min(n - 1, c0 + Math.ceil(viewport.w / CELL) + OVERSCAN * 2 + 1);
  const r1 = Math.min(n - 1, r0 + Math.ceil(viewport.h / CELL) + OVERSCAN * 2 + 1);

  const cells = [];
  for (let i = r0; i <= r1; i++) {
    for (let j = c0; j <= c1; j++) {
      const value = matrix[i][j];
      const key = i * n + j;
      const matched = matchedSet ? matchedSet.has(key) : false;
      const mark = matched && matchedMarks ? matchedMarks.get(key) : null;
      const justExcluded = excludedHint && excludedHint.i === i && excludedHint.j === j;
      cells.push(
        <Cell
          key={key}
          i={i}
          j={j}
          value={value}
          matched={matched}
          mark={mark}
          justExcluded={justExcluded}
          disabled={locked}
          onEdit={onEdit}
        />
      );
    }
  }

  // 匹配占用的列（由扁平 key=i*n+j 直接取模得到），避免每帧 O(n²) 扫描。
  const matchedCols = new Set();
  if (matchedSet) for (const key of matchedSet) matchedCols.add(key % n);

  const colHeaders = [];
  for (let j = Math.max(0, c0 - 1); j <= Math.min(n - 1, c1 + 1); j++) {
    colHeaders.push(
      <div
        key={`c${j}`}
        className={`col-head ${matchedCols.has(j) ? 'matched-head' : ''}`}
        style={{ left: HEAD + j * CELL, width: CELL }}
      >
        {j + 1}
      </div>
    );
  }

  const rowHeaders = [];
  for (let i = Math.max(0, r0 - 1); i <= Math.min(n - 1, r1 + 1); i++) {
    rowHeaders.push(
      <div key={`r${i}`} className="row-head" style={{ top: HEAD + i * CELL, height: CELL }}>
        {i + 1}
      </div>
    );
  }

  return (
    <div
      className="grid-scroll"
      ref={scrollRef}
      onScroll={onScroll}
      aria-label="代价矩阵编辑区"
    >
      <div className="grid-content" style={{ width: contentW, height: contentH }}>
        {cells}
        {/* 列头：横向随列自然滚动，纵向钉在顶部 */}
        <div className="heads-layer" style={{ transform: `translate(0,${scroll.top}px)` }}>
          {colHeaders}
        </div>
        {/* 行头：纵向随行自然滚动，横向钉在左侧 */}
        <div className="rows-layer" style={{ transform: `translate(${scroll.left}px,0)` }}>
          {rowHeaders}
        </div>
        <div
          className="corner"
          style={{ transform: `translate(${scroll.left}px,${scroll.top}px)` }}
        >
          探针\座
        </div>
      </div>
    </div>
  );
}

function Cell({ i, j, value, matched, mark, justExcluded, disabled, onEdit }) {
  const [text, setText] = useState(value === null ? '' : String(value));
  const [editing, setEditing] = useState(false);

  // 外部变更（随机/排除/重算）同步到输入框。
  useEffect(() => {
    setText(value === null ? '' : String(value));
  }, [value]);

  const commit = (raw) => {
    const t = raw.trim();
    if (t === '' || t === '✕' || t.toLowerCase() === 'x') {
      onEdit(i, j, null);
      setText('');
    } else {
      const num = Number(t);
      if (Number.isInteger(num) && num >= 0 && num <= 1_000_000_000_000) {
        onEdit(i, j, num);
        setText(String(num));
      } else {
        // 非法输入回滚为当前值
        setText(value === null ? '' : String(value));
      }
    }
    setEditing(false);
  };

  const isNull = value === null;
  const className = [
    'cell',
    isNull ? 'forbidden' : '',
    matched ? 'matched' : '',
    matched && mark === 'forced' ? 'match-forced' : '',
    matched && mark === 'flexible' ? 'match-flexible' : '',
    justExcluded ? 'just-excluded' : '',
  ]
    .filter(Boolean)
    .join(' ');

  const markHint =
    matched && mark === 'forced'
      ? '，必然连线（所有同价最优方案都采用）'
      : matched && mark === 'flexible'
        ? '，可替换（存在其他最优方案）'
        : '';

  return (
    <div
      className={className}
      style={{ left: HEAD + j * CELL, top: HEAD + i * CELL, width: CELL, height: CELL }}
      title={`探针 ${i + 1} → 测试座 ${j + 1}${isNull ? '（禁配）' : `，代价 ${value}`}${markHint}`}
      onDoubleClick={() => !disabled && setEditing(true)}
    >
      {editing && !disabled ? (
        <input
          autoFocus
          className="cell-input"
          value={text}
          inputMode="numeric"
          disabled={disabled}
          onChange={(e) => setText(e.target.value)}
          onBlur={(e) => commit(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit(e.currentTarget.value);
            if (e.key === 'Escape') {
              setText(value === null ? '' : String(value));
              setEditing(false);
            }
          }}
        />
      ) : isNull ? (
        <button
          className="forbidden-mark"
          disabled={disabled}
          title="双击或点击 ✕ 后输入代价可恢复该配对"
          onClick={() => !disabled && setEditing(true)}
        >
          ✕
        </button>
      ) : (
        <button
          className="cell-value"
          disabled={disabled}
          onClick={() => !disabled && setEditing(true)}
        >
          {value}
        </button>
      )}
    </div>
  );
}
