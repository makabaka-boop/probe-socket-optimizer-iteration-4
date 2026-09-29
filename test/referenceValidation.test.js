import { describe, it, expect } from 'vitest';
import { validateReference } from '../server/validation.js';

describe('validateReference：旧接线参考整批校验（求解前）', () => {
  it('合法排列通过并返回归一化副本', () => {
    const ref = [3, 0, 1, 2];
    const v = validateReference(ref, 4);
    expect(v.ok).toBe(true);
    expect(v.reference).toEqual([3, 0, 1, 2]);
    // 归一化副本：调用方之后改动原数组不影响结果
    ref[0] = 0;
    expect(v.reference[0]).toBe(3);
  });

  it('n=1：[0] 合法', () => {
    expect(validateReference([0], 1).ok).toBe(true);
  });

  it('恒等排列与任意打乱排列都合法', () => {
    expect(validateReference([0, 1, 2, 3], 4).ok).toBe(true);
    expect(validateReference([2, 3, 0, 1], 4).ok).toBe(true);
  });

  // 关键：参考边是否在新矩阵禁配不在此函数职责内——不接收矩阵，无法也不应拒绝。
  it('参考是否命中禁配边不做校验（禁配边仍可用于计变更数）', () => {
    expect(validateReference([0, 1], 2).ok).toBe(true);
  });

  const bad = [
    ['不是数组（字符串）', '01', 2],
    ['null', null, 2],
    ['undefined', undefined, 2],
    ['数字', 1, 2],
    ['对象', { 0: 0, 1: 1 }, 2],
    ['长度不足', [0], 2],
    ['长度超出', [0, 1, 2], 2],
    ['空数组对 n=2', [], 2],
    ['列重复（相邻）', [0, 0], 2],
    ['列重复（首尾）', [1, 1], 2],
    ['列越界 =n', [0, 2], 2],
    ['列越界负数', [-1, 1], 2],
    ['小数列下标', [0.5, 1], 2],
    ['字符串列下标', ['0', 1], 2],
    ['null 元素', [0, null], 2],
    ['布尔元素', [true, 1], 2],
    ['对象元素', [{}, 1], 2],
  ];
  for (const [name, reference, n] of bad) {
    it(`非法参考拒绝：${name}`, () => {
      const v = validateReference(reference, n);
      expect(v.ok).toBe(false);
      expect(typeof v.reason).toBe('string');
      expect(v.reference).toBeUndefined();
    });
  }

  it('n=1 边界：越界、重复形式均拒绝', () => {
    expect(validateReference([1], 1).ok).toBe(false);
    expect(validateReference([-0], 1).ok).toBe(true); // -0 === 0，合法整数
  });
});
