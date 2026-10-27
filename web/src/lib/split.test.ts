import { describe, expect, it } from 'vitest'
import {
  clampSplit,
  edgeSplit,
  orientationFor,
  SPLIT_DEFAULT,
  SPLIT_MAX,
  SPLIT_MIN,
  SPLIT_STEP,
  splitFromPointer,
  splitPercent,
  stepSplit
} from './split'

/**
 * 分栏算术。拖拽本身（pointer 事件）在 node 环境测不到，但把界面拖塌的从来不是事件，
 * 是这几个边界值：除零、NaN、拖到 0 或 1、localStorage 里存了个坏数。
 */
describe('clampSplit', () => {
  it('正常值原样过', () => {
    expect(clampSplit(0.5)).toBe(0.5)
    expect(clampSplit(SPLIT_MIN)).toBe(SPLIT_MIN)
    expect(clampSplit(SPLIT_MAX)).toBe(SPLIT_MAX)
  })

  it('太小与太大都收进区间，不留一栏为零', () => {
    expect(clampSplit(0)).toBe(SPLIT_MIN)
    expect(clampSplit(-3)).toBe(SPLIT_MIN)
    expect(clampSplit(1)).toBe(SPLIT_MAX)
  })

  it('NaN 与 Infinity 回落到默认值 —— Math.min/max 一路传 NaN 会让整个 grid 塌掉', () => {
    expect(clampSplit(Number.NaN)).toBe(SPLIT_DEFAULT)
    expect(clampSplit(Number.POSITIVE_INFINITY)).toBe(SPLIT_DEFAULT)
    expect(clampSplit(Number.NEGATIVE_INFINITY)).toBe(SPLIT_DEFAULT)
  })
})

describe('splitFromPointer', () => {
  it('指针在中点就是一半', () => {
    expect(splitFromPointer(450, 900, 0.2)).toBe(0.5)
  })

  it('容器宽度量不到（0 或负）时保持当前值，不去除', () => {
    expect(splitFromPointer(300, 0, 0.42)).toBe(0.42)
    expect(splitFromPointer(300, -10, 0.6)).toBe(0.6)
  })

  it('当前值本身是坏值时也会被收敛', () => {
    expect(splitFromPointer(100, 0, Number.NaN)).toBe(SPLIT_DEFAULT)
  })

  it('拖出容器外（负偏移 / 超宽）夹到端点', () => {
    expect(splitFromPointer(-80, 900, 0.5)).toBe(SPLIT_MIN)
    expect(splitFromPointer(4000, 900, 0.5)).toBe(SPLIT_MAX)
  })
})

describe('stepSplit（键盘调栏宽）', () => {
  it('一步就是 SPLIT_STEP', () => {
    expect(stepSplit(0.5, 1)).toBeCloseTo(0.5 + SPLIT_STEP, 10)
    expect(stepSplit(0.5, -1)).toBeCloseTo(0.5 - SPLIT_STEP, 10)
  })

  it('dir 为 0 时不动', () => {
    expect(stepSplit(0.44, 0)).toBe(0.44)
  })

  it('连着按到端点就停住，不会越界', () => {
    let r = 0.3
    for (let i = 0; i < 30; i++) r = stepSplit(r, -1)
    expect(r).toBe(SPLIT_MIN)
    let up = 0.7
    for (let i = 0; i < 30; i++) up = stepSplit(up, 1)
    expect(up).toBe(SPLIT_MAX)
  })
})

describe('edgeSplit 与读数', () => {
  it('Home / End 落在区间两端', () => {
    expect(edgeSplit('min')).toBe(SPLIT_MIN)
    expect(edgeSplit('max')).toBe(SPLIT_MAX)
  })

  it('给 aria-valuetext 的百分比是整数', () => {
    expect(splitPercent(0.561)).toBe(56)
    expect(splitPercent(Number.NaN)).toBe(Math.round(SPLIT_DEFAULT * 100))
  })
})

describe('orientationFor', () => {
  it('宽到放得下两栏才左右分', () => {
    expect(orientationFor(1600, 1100)).toBe('columns')
    expect(orientationFor(1101, 1100)).toBe('columns')
  })

  it('正好等于断点算窄（与 CSS 的 max-width: 1100px 那条对齐）', () => {
    expect(orientationFor(1100, 1100)).toBe('rows')
    expect(orientationFor(800, 1100)).toBe('rows')
  })
})
