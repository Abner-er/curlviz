import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  browserKeyValue,
  createBrowserStore,
  createStore,
  debounce,
  HISTORY_LIMIT,
  KEYS,
  memoryKeyValue,
  STORAGE_UNAVAILABLE_NOTE,
  storageFailureMessage,
  type KeyValue
} from './storage'

/** 记键名的假后端，顺便按需抛错。 */
function fakeBackend(onSet?: (value: string) => void): KeyValue & { written: Map<string, string> } {
  const written = new Map<string, string>()
  return {
    written,
    getItem: (k) => (written.has(k) ? (written.get(k) as string) : null),
    setItem: (k, v) => {
      if (onSet) onSet(v)
      written.set(k, v)
    },
    removeItem: (k) => {
      written.delete(k)
    }
  }
}

describe('createStore', () => {
  it('读写走命名空间，round-trip 保结构', () => {
    const backend = fakeBackend()
    const store = createStore(backend)
    const draft = { spec: { url: 'https://x' }, tab: 'headers' }

    expect(store.save(KEYS.draft, draft).ok).toBe(true)
    expect([...backend.written.keys()]).toEqual(['curlviz.draft'])
    expect(store.load(KEYS.draft, null)).toEqual(draft)
  })

  it('没存过 / 存坏了解不开时给 fallback，而不是崩', () => {
    const backend = fakeBackend()
    const store = createStore(backend)
    expect(store.load(KEYS.history, [])).toEqual([])

    backend.written.set('curlviz.history', '{不是JSON')
    expect(store.load(KEYS.history, ['默认'])).toEqual(['默认'])
  })

  it('后端读的时候抛错也当没有', () => {
    const store = createStore({
      getItem: () => {
        throw new Error('SecurityError')
      },
      setItem: () => {},
      removeItem: () => {}
    })
    expect(store.load(KEYS.vars, {})).toEqual({})
  })

  it('配额超限报 quota（Chrome 与 Firefox 的异常名不一样，都得认）', () => {
    const chrome = createStore(
      fakeBackend(() => {
        throw Object.assign(new Error('quota'), { name: 'QuotaExceededError' })
      })
    )
    const firefox = createStore(
      fakeBackend(() => {
        throw Object.assign(new Error('quota'), { name: 'NS_ERROR_DOM_QUOTA_REACHED' })
      })
    )
    const legacy = createStore(
      fakeBackend(() => {
        throw Object.assign(new Error('quota'), { code: 22 })
      })
    )
    for (const store of [chrome, firefox, legacy]) {
      const r = store.save(KEYS.history, [])
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.reason).toBe('quota')
    }
  })

  it('其它写入失败报 unavailable（隐私模式之类）', () => {
    const store = createStore(
      fakeBackend(() => {
        throw new Error('localStorage 被禁用')
      })
    )
    const r = store.save(KEYS.settings, {})
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('unavailable')
  })

  it('值里转不了的东西（循环引用）报 unavailable，不炸界面', () => {
    const circular: Record<string, unknown> = {}
    circular.self = circular
    const r = createStore(memoryKeyValue()).save(KEYS.draft, circular)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('unavailable')
  })

  it('remove 静默失败不抛', () => {
    const store = createStore({
      getItem: () => null,
      setItem: () => {},
      removeItem: () => {
        throw new Error('nope')
      }
    })
    expect(() => store.remove(KEYS.history)).not.toThrow()
  })

  it('历史上限是 50 条（运维翻不到更深，再多只撑爆 localStorage）', () => {
    expect(HISTORY_LIMIT).toBe(50)
  })
})

describe('browserKeyValue', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('环境里没有 localStorage 时返回 null，让调用方改用内存后端', () => {
    expect(browserKeyValue()).toBeNull()
  })

  it('localStorage 写探针就抛（隐私模式）时同样返回 null', () => {
    vi.stubGlobal('localStorage', {
      setItem: () => {
        throw new Error('SecurityError')
      },
      getItem: () => null,
      removeItem: () => {}
    })
    expect(browserKeyValue()).toBeNull()
  })

  it('能写探针才返回后端', () => {
    const ls = memoryKeyValue()
    vi.stubGlobal('localStorage', ls)
    expect(browserKeyValue()).toBe(ls)
  })
})

describe('debounce', () => {
  it('连点只落最后一次，且等到时限才写', () => {
    vi.useFakeTimers()
    try {
      const calls: number[] = []
      const push = debounce((n: number) => calls.push(n), 500)
      push(1)
      push(2)
      push(3)
      expect(calls).toEqual([])
      vi.advanceTimersByTime(499)
      expect(calls).toEqual([])
      vi.advanceTimersByTime(1)
      expect(calls).toEqual([3])
    } finally {
      vi.useRealTimers()
    }
  })

  it('超时后再点是新的一次（草稿不会被合并到无关的编辑上）', () => {
    vi.useFakeTimers()
    try {
      const calls: number[] = []
      const push = debounce((n: number) => calls.push(n), 500)
      push(1)
      vi.advanceTimersByTime(500)
      push(2)
      vi.advanceTimersByTime(500)
      expect(calls).toEqual([1, 2])
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('storageFailureMessage', () => {
  it('quota 说成"空间不足"，其它说成"不可用"（两种故障用户能做的事不一样）', () => {
    expect(storageFailureMessage('集合', 'quota', '这部分改动关掉页面就没了。')).toBe(
      '集合写入本地存储失败（空间不足），这部分改动关掉页面就没了。'
    )
    expect(storageFailureMessage('集合', 'unavailable', '这部分改动关掉页面就没了。')).toBe(
      '集合写入本地存储失败（不可用），这部分改动关掉页面就没了。'
    )
  })

  it('后果由调用方给：草稿丢了和集合丢了不能共用一句粉饰话', () => {
    expect(storageFailureMessage('草稿', 'quota', '草稿可能留不住。')).toContain('草稿可能留不住。')
    expect(storageFailureMessage('历史', 'quota', '只保留在这次会话里。')).toContain('只保留在这次会话里。')
  })
})

describe('createBrowserStore', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('探测不到 localStorage 时 available=false，但仍能用（内存后端把功能兜住，不崩）', () => {
    const { store, available } = createBrowserStore()
    expect(available).toBe(false)
    expect(store.save(KEYS.draft, { url: 'https://x' }).ok).toBe(true)
    expect(store.load(KEYS.draft, null)).toEqual({ url: 'https://x' })
    expect(STORAGE_UNAVAILABLE_NOTE).toContain('只在这次会话里有效')
  })

  it('后端可用时 available=true，且写的确实是那个后端（探测结果与实际后端不能来自两次判定）', () => {
    const backend = fakeBackend()
    vi.stubGlobal('localStorage', backend)
    const { store, available } = createBrowserStore()
    expect(available).toBe(true)
    store.save(KEYS.collections, { collections: [] })
    expect([...backend.written.keys()]).toEqual(['curlviz.collections'])
  })
})
