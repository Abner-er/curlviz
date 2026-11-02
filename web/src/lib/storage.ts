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
  openRef: 'openRef',
  /**
   * 执行机注册表（ExecutorRegistry）：只存 {id,name,baseUrl} 三样。
   * token 绝不进这个键——它只活在会话内存里（见 lib/executors 决策②）。
   */
  executors: 'executors'
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

/** 后端在（浏览器隐私模式 / file:// / 被策略禁用）探测不到时的提示：功能不塌，但要说清留不住。 */
export const STORAGE_UNAVAILABLE_NOTE = '本地存储不可用，草稿与历史只在这次会话里有效。'

/**
 * 写入失败的人话说明。
 *
 * 抽成函数是因为"quota → 空间不足、其它 → 不可用"这条映射原来在 App 里抄了三遍
 * （草稿 / 资料库 / 历史），措辞一旦分家，用户就会看到三种说法猜到底是哪种故障。
 * `consequence` 由调用方给：草稿丢了和集合丢了严重程度不一样，不该由存储层统一粉饰。
 */
export function storageFailureMessage(label: string, reason: 'quota' | 'unavailable', consequence: string): string {
  return `${label}写入本地存储失败（${reason === 'quota' ? '空间不足' : '不可用'}），${consequence}`
}

export interface StoreBundle {
  store: Store
  /** false = 没拿到真的 localStorage，用的是内存后端（数据留不住，界面必须说）。 */
  available: boolean
}

/**
 * 建一次、探测一次。
 * 原来 App 里 `createStore(browserKeyValue() ?? memoryKeyValue())` 加 `browserKeyValue() !== null`
 * 会写两次探测键；不算错，但"探测结果"和"实际用的后端"可能来自两次不同判定，读代码时得费劲确认它们一致。
 */
export function createBrowserStore(namespace = 'curlviz.'): StoreBundle {
  const backend = browserKeyValue()
  return { store: createStore(backend ?? memoryKeyValue(), namespace), available: backend !== null }
}
