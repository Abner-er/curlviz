import { useCallback, useEffect, useMemo, useState } from 'react'
import type { TransportSelector } from '../types'
import { newId } from '../lib/collections'
import { KEYS, type Store } from '../lib/storage'
import type { Persistence } from './usePersistence'
import {
  addExecutor,
  buildTransport,
  NO_EXECUTORS,
  removeExecutor,
  sanitizeRegistry,
  setActive,
  updateExecutor,
  type ExecutorRegistry
} from '../lib/executors'

/**
 * 执行机这摊状态的容器：注册表落盘（走持久化层，失败提示才有同一句话），
 * token 只进会话内存的这张表 —— 刷新即清空，要重新填（决策②）。
 *
 * 判断和增删改全在 lib/executors 的纯函数里，这里只做 React 的接线，
 * 所以不需要单独的钩子测试：纯函数那层已经钉死了行为。
 */

const REGISTRY_CONSEQUENCE = '这台机器上存的执行机列表可能留不住。'

export interface ExecutorsApi {
  registry: ExecutorRegistry
  /** 现算的发送路径：没选中 / 悬空都回落浏览器。 */
  transport: TransportSelector
  /** 某台在当前会话里是否已填过 token（落盘那份没有，只能问这张内存表）。 */
  tokenOf: (id: string) => string
  select: (id: string | null) => void
  add: (input: { name: string; baseUrl: string; token: string }) => void
  update: (id: string, patch: { name?: string; baseUrl?: string }) => void
  remove: (id: string) => void
  setToken: (id: string, token: string) => void
}

export function useExecutors(store: Store, persistence: Persistence): ExecutorsApi {
  const [registry, setRegistry] = useState<ExecutorRegistry>(() =>
    sanitizeRegistry(store.load<unknown>(KEYS.executors, NO_EXECUTORS))
  )
  // 会话内存里的 token 表：id → token。刷新页面就没了，这是刻意的。
  const [tokens, setTokens] = useState<Record<string, string>>({})

  // 注册表变了就落盘；token 不在 registry 里，压根不会被写进这个键。
  useEffect(() => {
    persistence.write(KEYS.executors, registry, '执行机', REGISTRY_CONSEQUENCE)
  }, [registry, persistence])

  const transport = useMemo(() => buildTransport(registry, tokens), [registry, tokens])

  const tokenOf = useCallback((id: string) => tokens[id] ?? '', [tokens])

  const select = useCallback((id: string | null) => setRegistry((r) => setActive(r, id)), [])

  const add = useCallback<ExecutorsApi['add']>(({ name, baseUrl, token }) => {
    // 先把 id 定下来：这样两次 setState 各自独立、都是纯的（StrictMode 下重复跑也同结果），
    // 也拿得到新建那条的 id 好把 token 塞进会话内存表
    const id = newId('ex')
    setRegistry((r) => addExecutor(r, { name, baseUrl }, id).registry)
    if (token.trim() !== '') setTokens((t) => ({ ...t, [id]: token }))
  }, [])

  const update = useCallback<ExecutorsApi['update']>((id, patch) => setRegistry((r) => updateExecutor(r, id, patch)), [])

  const remove = useCallback((id: string) => {
    setRegistry((r) => removeExecutor(r, id))
    // 删一台就把它的会话 token 一起抹掉：留着是给已经不存在的东西存钥匙
    setTokens((t) => {
      if (!(id in t)) return t
      const { [id]: _drop, ...rest } = t
      return rest
    })
  }, [])

  const setToken = useCallback((id: string, token: string) => setTokens((t) => ({ ...t, [id]: token })), [])

  return { registry, transport, tokenOf, select, add, update, remove, setToken }
}
