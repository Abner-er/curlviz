import { useCallback, useEffect, useMemo, useState } from 'react'
import type { CurlSpec } from '@curlviz/core'
import type { Settings } from '../types'
import type { EnvState } from '../lib/environments'
import type { CollectionState, OpenRef } from '../lib/collections'
import {
  KEYS,
  STORAGE_UNAVAILABLE_NOTE,
  debounce,
  storageFailureMessage,
  type StoreBundle,
  type StoreKey
} from '../lib/storage'

/**
 * 落盘这件事集中在这里。
 *
 * 原来 App.tsx 里有 5 个写存储的地方（草稿防抖 / 设置 / 环境 / 集合 / 打开位置），
 * 每处自己拼失败文案、自己决定要不要提示。后果不是难看，是**不一致**：
 * 同一个配额爆了，草稿那条只说"可能留不住"，集合那条什么都不说。
 * 收拢之后，"写失败必须让人看见"这条规矩只需要在一个地方保证。
 */

/** 草稿防抖时长：再短就还是每敲一下写一次，再长就有关掉浏览器丢草稿的风险。 */
const DRAFT_DEBOUNCE_MS = 500

/** 资料库类数据写失败的后果 —— 说清楚丢的是"没保存的改动"，不是笼统的"失败"。 */
const LIBRARY_CONSEQUENCE = '这部分改动关掉页面就没了。'

export interface LiveValues {
  draft: CurlSpec
  settings: Settings
  environments: EnvState
  collections: CollectionState
  openRef: OpenRef
}

export interface Persistence {
  /** 最近一次存储故障的人话说明；null = 一切正常。 */
  storageIssue: string | null
  dismissStorageIssue: () => void
  /** 主动写一次（历史这类"值要调用方自己算好"的场景），返回是否落盘成功。 */
  write: (key: StoreKey, value: unknown, label: string, consequence: string) => boolean
  /** 静默删除（清理旧键这类，删不掉没有后果，就不假装成功也不报错）。 */
  erase: (key: StoreKey) => void
}

export function usePersistence(bundle: StoreBundle, values: LiveValues): Persistence {
  const store = bundle.store
  const { draft, settings, environments, collections, openRef } = values

  // 开机就没探到 localStorage 时先说清楚：不然用户要等到丢草稿才发现这台机器存不住东西
  const [storageIssue, setStorageIssue] = useState<string | null>(bundle.available ? null : STORAGE_UNAVAILABLE_NOTE)

  const write = useCallback<Persistence['write']>(
    (key, value, label, consequence) => {
      const r = store.save(key, value)
      if (!r.ok) setStorageIssue(storageFailureMessage(label, r.reason, consequence))
      return r.ok
    },
    [store]
  )

  const erase = useCallback<Persistence['erase']>((key) => store.remove(key), [store])

  const dismissStorageIssue = useCallback(() => setStorageIssue(null), [])

  /**
   * 草稿走防抖：这条路径上失败只影响"这次编辑留不留得住"，
   * 和集合库写失败的严重程度不同，所以后果那句话也不同。
   */
  const saveDraft = useMemo(
    () =>
      debounce((s: CurlSpec) => {
        const r = store.save(KEYS.draft, s)
        if (!r.ok) setStorageIssue(storageFailureMessage('草稿', r.reason, '草稿可能留不住。'))
      }, DRAFT_DEBOUNCE_MS),
    [store]
  )

  useEffect(() => {
    saveDraft(draft)
  }, [draft, saveDraft])

  useEffect(() => {
    write(KEYS.settings, settings, '设置', '这个选择下次开机可能变回去。')
  }, [settings, write])

  useEffect(() => {
    write(KEYS.environments, environments, '环境变量', LIBRARY_CONSEQUENCE)
  }, [environments, write])

  useEffect(() => {
    write(KEYS.collections, collections, '集合', LIBRARY_CONSEQUENCE)
  }, [collections, write])

  useEffect(() => {
    write(KEYS.openRef, openRef, '打开位置', '刷新后就不记得你正在改集合里的哪一条了。')
  }, [openRef, write])

  return { storageIssue, dismissStorageIssue, write, erase }
}
