/**
 * 本地存储：草稿、历史、设置、环境变量。全部留在浏览器自己的 localStorage 里，
 * 没有任何网络请求会把它们发出去——"数据全本地"是这工具的卖点，不能嘴上说说。
 *
 * 刻意做成"注入后端"的形状：
 *  - 测试传内存 Map，不用装 jsdom；
 *  - 隐私模式 / file:// 下 localStorage 会直接抛错，这里吞掉并如实上报，
 *    让界面能说"本地存储不可用，历史只在这次会话里有效"，而不是静默丢数据。
 */

export interface KeyValue {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

export const KEYS = {
  draft: 'draft',
  history: 'history',
  settings: 'settings',
  /** M1 的扁平变量表；M2 起迁移进 environments 的「默认」环境，键仍留着是为了能读旧数据。 */
  vars: 'vars',
  /** 集合库（CollectionState）。 */
  collections: 'collections',
  /** 命名环境与当前激活项（EnvState）。 */
  environments: 'environments',
  /** 编辑器里这条 spec 是从哪个集合的哪条请求打开的（支持"改完就地更新"）。 */
  openRef: 'openRef'
} as const

export type StoreKey = (typeof KEYS)[keyof typeof KEYS]

/** 历史条数上限：再多就只是把 localStorage 撑爆，运维翻不到那么深。 */
export const HISTORY_LIMIT = 50

export type SaveResult = { ok: true } | { ok: false; reason: 'quota' | 'unavailable'; message: string }

export interface Store {
  load<T>(key: StoreKey, fallback: T): T
  save(key: StoreKey, value: unknown): SaveResult
  remove(key: StoreKey): void
}

/** 内存后端，测试与非浏览器环境用。 */
export function memoryKeyValue(): KeyValue {
  const map = new Map<string, string>()
  return {
    getItem: (k) => (map.has(k) ? (map.get(k) as string) : null),
    setItem: (k, v) => {
      map.set(k, v)
    },
    removeItem: (k) => {
      map.delete(k)
    }
  }
}

/** 浏览器 localStorage；不可用（隐私模式、file://、被禁用）时返回 null。 */
export function browserKeyValue(): KeyValue | null {
  try {
    const ls = globalThis.localStorage
    if (!ls) return null
    const probe = '__curlviz_probe__'
    ls.setItem(probe, '1')
    ls.removeItem(probe)
    return ls
  } catch {
    return null
  }
}

export function createStore(backend: KeyValue, namespace = 'curlviz.'): Store {
  const full = (key: StoreKey): string => `${namespace}${key}`
  return {
    load<T>(key: StoreKey, fallback: T): T {
      const raw = safeGet(backend, full(key))
      if (raw === null) return fallback
      try {
        return JSON.parse(raw) as T
      } catch {
        // 读到坏数据（版本变更手改过、写一半掉电）当没有，别把界面搞崩
        return fallback
      }
    },
    save(key: StoreKey, value: unknown): SaveResult {
      let text: string
      try {
        text = JSON.stringify(value)
      } catch (e) {
        return { ok: false, reason: 'unavailable', message: String(e) }
      }
      try {
        backend.setItem(full(key), text)
        return { ok: true }
      } catch (e) {
        // Firefox/Chrome 配额超限抛 QuotaExceededError，名字不完全一致，按名字 + code 都判一遍
        const err = e as { name?: string; code?: number }
        const quota = err.name === 'QuotaExceededError' || err.name === 'NS_ERROR_DOM_QUOTA_REACHED' || err.code === 22
        return { ok: false, reason: quota ? 'quota' : 'unavailable', message: String(e) }
      }
    },
    remove(key: StoreKey): void {
      try {
        backend.removeItem(full(key))
      } catch {
        /* 删不掉也没什么后果，不假装成功也不弹错 */
      }
    }
  }
}

function safeGet(backend: KeyValue, key: string): string | null {
  try {
    return backend.getItem(key)
  } catch {
    return null
  }
}

/** 500ms 防抖：每次按键都写 localStorage 会把主线程拖住，而且没必要。 */
export function debounce<A extends unknown[]>(fn: (...args: A) => void, waitMs: number): (...args: A) => void {
  let timer: ReturnType<typeof setTimeout> | null = null
  return (...args: A) => {
    if (timer !== null) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      fn(...args)
    }, waitMs)
  }
}
