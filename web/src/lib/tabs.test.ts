import { describe, expect, it } from 'vitest'
import { shiftTab } from './tabs'

const TABS = ['query', 'headers', 'body', 'auth', 'options'] as const
type T = (typeof TABS)[number]

describe('shiftTab（tab 之间方向键循环）', () => {
  it('向右走到头就回到第一个', () => {
    expect(shiftTab(TABS, 'options', 1)).toBe('query')
    expect(shiftTab(TABS, 'query', 1)).toBe('headers')
  })

  it('向左走到头落到最后一个（不是 undefined，键盘不该按不动）', () => {
    expect(shiftTab(TABS, 'query', -1)).toBe('options')
    expect(shiftTab(TABS, 'body', -1)).toBe('headers')
  })

  it('中间位置正常移动', () => {
    expect(shiftTab(TABS, 'body', 2)).toBe('options')
    expect(shiftTab(TABS, 'body', -2)).toBe('query')
  })

  it('当前 tab 名已经不在列表里时给一个能用的落点', () => {
    expect(shiftTab(TABS, 'vars' as unknown as T, 1)).toBe('query')
    expect(shiftTab(TABS, 'vars' as unknown as T, -1)).toBe('options')
  })

  it('空列表与单元素列表都不炸', () => {
    expect(shiftTab([] as T[], 'query', 1)).toBe('query')
    const ONE = ['only'] as const
    expect(shiftTab(ONE, 'only', 1)).toBe('only')
    expect(shiftTab(ONE, 'only', -3)).toBe('only')
  })

  it('跨越整圈的步数也落在正确位置（多列 tab 用大位移）', () => {
    expect(shiftTab(TABS, 'query', 5)).toBe('query')
    expect(shiftTab(TABS, 'query', 6)).toBe('headers')
    expect(shiftTab(TABS, 'query', -5)).toBe('query')
    expect(shiftTab(TABS, 'headers', -6)).toBe('query')
    expect(shiftTab(TABS, 'headers', -7)).toBe('options')
  })
})
