import { describe, expect, it } from 'vitest'
import { cycleIndex, FOCUSABLE_SELECTOR } from './focus'

describe('cycleIndex（弹窗内 Tab 焦点循环）', () => {
  it('走到末尾接着回第一个，走到开头接着回最后一个', () => {
    expect(cycleIndex(4, 3, 1)).toBe(0)
    expect(cycleIndex(4, 0, -1)).toBe(3)
    expect(cycleIndex(4, 1, 1)).toBe(2)
    expect(cycleIndex(4, 2, -1)).toBe(1)
  })

  it('一个可聚焦元素都没有时给 -1，让调用方什么都不做', () => {
    expect(cycleIndex(0, 0, 1)).toBe(-1)
    expect(cycleIndex(0, -1, -1)).toBe(-1)
    expect(cycleIndex(-2, 0, 1)).toBe(-1)
  })

  it('只有一个元素时前后都停在它身上（Shift+Tab 不会跳出去）', () => {
    expect(cycleIndex(1, 0, 1)).toBe(0)
    expect(cycleIndex(1, 0, -1)).toBe(0)
  })

  it('当前下标越界时直接给落点，不多走一步（第一项不能被吃掉）', () => {
    // 越界是常态：刚打开弹窗时焦点停在容器自己身上（tabIndex=-1，不在这个列表里），
    // 这时按第一次 Tab 就该进第一项
    expect(cycleIndex(3, -1, 1)).toBe(0)
    expect(cycleIndex(3, -1, -1)).toBe(2)
    // 列表变短了（二维码按钮换成"生成中"的文案）而焦点还挂在旧元素上：同理给个能用的落点
    expect(cycleIndex(3, 7, 1)).toBe(0)
    expect(cycleIndex(3, 7, -1)).toBe(2)
  })

  it('大位移按整圈取模', () => {
    expect(cycleIndex(5, 0, 5)).toBe(0)
    expect(cycleIndex(5, 0, 6)).toBe(1)
    expect(cycleIndex(5, 0, -6)).toBe(4)
  })
})

describe('FOCUSABLE_SELECTOR', () => {
  it('覆盖弹窗里会出现的控件，并显式排除 tabindex="-1" 的容器', () => {
    // 弹窗自身是 tabIndex={-1} 的落焦容器：它必须能被 :focus 但不能被 Tab 走到，
    // 否则 Tab 序列里多出一个"谁也看不见"的停靠点
    expect(FOCUSABLE_SELECTOR).toContain('button')
    expect(FOCUSABLE_SELECTOR).toContain('input')
    expect(FOCUSABLE_SELECTOR).toContain('textarea')
    expect(FOCUSABLE_SELECTOR).toContain('select')
    expect(FOCUSABLE_SELECTOR).toContain('[tabindex="-1"]')
  })
})
