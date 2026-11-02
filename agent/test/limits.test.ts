import { describe, expect, it } from 'vitest'
import { createRateLimiter, createSemaphore } from '../src/limits'

describe('createRateLimiter：60s 滑动窗口', () => {
  it('窗口内到量即拒，过窗又放行', () => {
    let t = 0
    const rl = createRateLimiter(3, { now: () => t })
    expect(rl.allow()).toBe(true)
    expect(rl.allow()).toBe(true)
    expect(rl.allow()).toBe(true)
    expect(rl.allow()).toBe(false) // 第 4 笔，仍在窗口
    t = 61_000 // 第一笔过期
    expect(rl.allow()).toBe(true)
  })
  it('perMinute<=0 一律拒', () => {
    const rl = createRateLimiter(0, { now: () => 0 })
    expect(rl.allow()).toBe(false)
  })
})

describe('createSemaphore：并发上限', () => {
  it('满则拒、release 腾位', () => {
    const s = createSemaphore(2)
    expect(s.tryAcquire()).toBe(true)
    expect(s.tryAcquire()).toBe(true)
    expect(s.active()).toBe(2)
    expect(s.tryAcquire()).toBe(false)
    s.release()
    expect(s.tryAcquire()).toBe(true)
    expect(s.active()).toBe(2)
  })
  it('多余 release 不把计数压成负', () => {
    const s = createSemaphore(1)
    s.release()
    expect(s.active()).toBe(0)
    expect(s.tryAcquire()).toBe(true)
  })
})
