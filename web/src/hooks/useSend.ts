import { useCallback, useEffect, useRef, useState } from 'react'
import { generateCurl, type CurlSpec } from '@curlviz/core'
import type { HistoryEntry, SendReport, Settings } from '../types'
import { sendSpec, toolFailureReport } from '../lib/http'
import { appendHistory, makeHistoryEntry, resultFromOutcome } from '../lib/history'
import { newId } from '../lib/collections'
import { KEYS } from '../lib/storage'
import type { Persistence } from './usePersistence'

/**
 * 发送这件事的全部副作用：请求生命周期 + 结果 + 写一条历史 + Ctrl/Cmd+Enter。
 *
 * 原来这些都摊在 App.tsx 的 onSend 里，其中最要命的一行是
 * `settings.redactHistory && hasSensitive(spec)` 被写了两遍 —— 一遍决定存进去的 spec，
 * 一遍决定 redacted 标记。两遍判断之间只要有人改动其中一处，历史里就会出现
 * "存的是明文、标记写着已脱敏"的条目，而这正是用户最没法自己发现的那种错。
 * 现在判断收在 lib/history 的 makeHistoryEntry 里，只做一次。
 */

export interface SendInput {
  spec: CurlSpec
  vars: Record<string, string>
  settings: Settings
  /** 结果放在工作台（workbench.report），因为"换一条请求要撤掉上一次的结果"是工作台的事。 */
  setReport: (r: SendReport | null) => void
  /** 存储写入统一走持久化层，失败提示才有同一句话。 */
  persistence: Persistence
  initialHistory: HistoryEntry[]
}

export interface Sender {
  sending: boolean
  /** URL 没填就不能发：界面上的禁用态与快捷键共用这一个判断。 */
  canSend: boolean
  history: HistoryEntry[]
  send: () => Promise<void>
  cancel: () => void
  removeHistory: (id: string) => void
  clearHistory: () => void
}

const HISTORY_CONSEQUENCE = '只保留在这次会话里。'

export function useSend(input: SendInput): Sender {
  const { spec, vars, settings, setReport, persistence, initialHistory } = input
  const [sending, setSending] = useState(false)
  const [history, setHistory] = useState<HistoryEntry[]>(initialHistory)
  const abortRef = useRef<AbortController | null>(null)
  /** 用 ref 而不是 sending 判重发：setState 之后的那一次渲染之前，sending 还是旧值。 */
  const inFlightRef = useRef(false)

  const send = useCallback(async () => {
    if (inFlightRef.current) return
    inFlightRef.current = true
    const controller = new AbortController()
    abortRef.current = controller
    setSending(true)
    setReport(null)

    let r: SendReport
    try {
      r = await sendSpec(spec, {
        vars,
        generate: { quoteStyle: settings.quoteStyle, multiline: settings.multiline },
        signal: controller.signal
      })
    } catch (e) {
      // sendSpec 设计上不抛错。真抛了就把异常如实摆出来，而不是让按钮永远转圈、
      // 界面上继续挂着上一次的结果 —— 那种"看起来还在正常状态"的故障最难被发现。
      // 这一条不进历史：根本没发出去的东西混进"上次发过什么"里，只会误导下一次排查。
      const curl = generateCurl(spec, { quoteStyle: settings.quoteStyle, multiline: settings.multiline })
      setReport(toolFailureReport(e, curl, Date.now()))
      return
    } finally {
      abortRef.current = null
      inFlightRef.current = false
      setSending(false)
    }

    setReport(r)
    const entry = makeHistoryEntry({
      spec,
      sentAt: r.sentAt,
      id: newId('hist'),
      redactHistory: settings.redactHistory,
      result: resultFromOutcome(r.outcome)
    })
    const next = appendHistory(history, entry)
    setHistory(next)
    persistence.write(KEYS.history, next, '历史', HISTORY_CONSEQUENCE)
  }, [spec, vars, settings, setReport, persistence, history])

  const cancel = useCallback(() => {
    abortRef.current?.abort()
  }, [])

  const removeHistory = useCallback(
    (id: string) => {
      const next = history.filter((h) => h.id !== id)
      setHistory(next)
      persistence.write(KEYS.history, next, '历史', HISTORY_CONSEQUENCE)
    },
    [history, persistence]
  )

  const clearHistory = useCallback(() => {
    setHistory([])
    // 清空是"删键"而不是"写空数组"：开机读回来应当是真的没有，而不是留一条空记录
    persistence.erase(KEYS.history)
  }, [persistence])

  const canSend = spec.url.trim() !== ''

  // Ctrl/Cmd+Enter 发送：改一条命令要按几十次，少一次鼠标位移
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (!(e.ctrlKey || e.metaKey) || e.key !== 'Enter') return
      if (!canSend || sending) return
      /**
       * 有弹层开着就不抢这颗键。
       * 粘贴导入框里按 Ctrl+Enter 的意思是"解析我粘的这段"，同一次按键顺手把编辑器里
       * 那条旧命令发出去，等于白送一个请求出去 —— 而抽屉里那些按钮（存入 / 打开）
       * 本身也认这颗键。判断只看有没有 dialog，不看谁持有焦点：
       * 焦点这时可能在 textarea、可能在容器自己身上，两种都得拦住。
       */
      if (document.querySelector('[role="dialog"]') !== null) return
      e.preventDefault()
      void send()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [send, sending, canSend])

  return { sending, canSend, history, send, cancel, removeHistory, clearHistory }
}
