import { describe, expect, it } from 'vitest'
import { enterLayer, isTopLayer, layerCount, leaveLayer } from './layers'

/**
 * 叠放次序。
 *
 * 这条逻辑只有在两个弹层叠起来时才暴露问题（抽屉里点「分享」），
 * 而"叠两层点一下 Esc 全没了"这种错在人工点验里最容易被当成小毛病放过去，
 * 所以把它挪出 DOM，逐条钉住。
 */
describe('弹层叠放次序', () => {
  it('没有弹层时层数为 0，谁也谈不上"最上面"', () => {
    expect(layerCount()).toBe(0)
    expect(isTopLayer(Symbol('nobody'))).toBe(false)
  })

  it('两层叠着时只有最上面那层该收到 Escape', () => {
    const drawer = Symbol('drawer')
    const share = Symbol('share')
    enterLayer(drawer)
    enterLayer(share)
    expect(layerCount()).toBe(2)
    expect(isTopLayer(share)).toBe(true)
    expect(isTopLayer(drawer)).toBe(false)

    // 关里层：外层重新变成最上面，而且背景必须继续锁着 —— 层数还剩 1，不是 0
    leaveLayer(share)
    expect(layerCount()).toBe(1)
    expect(isTopLayer(drawer)).toBe(true)
    leaveLayer(drawer)
    expect(layerCount()).toBe(0)
  })

  it('同一层重复 enter 不会把自己叠两遍', () => {
    const a = Symbol('a')
    enterLayer(a)
    enterLayer(a)
    expect(layerCount()).toBe(1)
    leaveLayer(a)
    expect(layerCount()).toBe(0)
  })

  it('leave 一枚不在栈里的令牌是空操作', () => {
    // 弹层卸载顺序乱了（StrictMode 下 effect 会跑两遍）也不该把别人的层数减掉，
    // 否则背景会先解锁一下再锁回去，用户看见的就是"能点穿"的一瞬
    const a = Symbol('a')
    enterLayer(a)
    leaveLayer(Symbol('ghost'))
    expect(layerCount()).toBe(1)
    expect(isTopLayer(a)).toBe(true)
    leaveLayer(a)
  })
})
