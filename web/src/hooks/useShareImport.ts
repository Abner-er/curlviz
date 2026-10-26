import { useEffect, useRef } from 'react'
import { clearShareHash, decodeShare, shareErrorText, type SharePayload } from '../lib/share'
import { hasShareHash } from '../lib/bootstrap'

/**
 * 开机时地址栏带着 `#share=...` 就自动导入 —— "同事发你一条命令"最短的那条路。
 *
 * 单独成一个 hook 有两个原因：
 *  1. 这段是异步的，挂载之外不能再触发。colState / envState 每次变更都重跑的话，
 *     同一个链接会被导入很多遍（hash 虽然抹了，effect 却已经排队在跑）。
 *  2. 处理函数必须拿到"当下"的状态。直接闭包捕获会让 lint 抱怨依赖，
 *     写全依赖又变成原因 1 那个 bug。所以用 ref 转存最新回调，effect 本身只跑一次。
 */

export interface ShareImportHandlers {
  /** 解码成功。参数是载荷内容，落地成什么状态由调用方决定（bootstrap.applySharePayload）。 */
  onPayload: (payload: SharePayload) => void
  /** 解码失败，已经是人话。 */
  onError: (message: string) => void
}

export function useShareImport(handlers: ShareImportHandlers): void {
  const ref = useRef(handlers)
  ref.current = handlers

  useEffect(() => {
    const hash = globalThis.location?.hash ?? ''
    if (!hasShareHash(hash)) return
    let cancelled = false
    decodeShare(hash)
      .then((payload) => {
        if (!cancelled) ref.current.onPayload(payload)
      })
      .catch((e: unknown) => {
        if (!cancelled) ref.current.onError(shareErrorText(e))
      })
      .finally(() => {
        // 成功与失败都要抹：留着地址，刷新一次就再撞一遍同一个码
        clearShareHash()
      })
    return () => {
      cancelled = true
    }
  }, [])
}
