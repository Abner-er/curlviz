/**
 * 有状态的限流：滑动窗口速率 + 并发信号量。单独成模块是为了把"计数逻辑"从 node http 里
 * 剥出来用假时钟直接测；server 只负责在合适的时机调它们。
 */

export interface RateLimiter {
  /** 现在放行与否：过去 60s 内未超 perMinute 才放行并记一笔。 */
  allow(): boolean
}

export function createRateLimiter(perMinute: number, opts: { now?: () => number } = {}): RateLimiter {
  const now = opts.now ?? (() => Date.now())
  let hits: number[] = []
  return {
    allow() {
      const t = now()
      const cutoff = t - 60_000
      hits = hits.filter((x) => x > cutoff)
      if (hits.length >= perMinute) return false
      hits.push(t)
      return true
    }
  }
}

export interface Semaphore {
  tryAcquire(): boolean
  release(): void
  active(): number
}

export function createSemaphore(max: number): Semaphore {
  let n = 0
  return {
    tryAcquire() {
      if (n >= max) return false
      n += 1
      return true
    },
    release() {
      n = Math.max(0, n - 1)
    },
    active() {
      return n
    }
  }
}
