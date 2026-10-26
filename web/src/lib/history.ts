import { REDACTED_MASK, cloneSpec, hasRedactedValues, hasSensitive, redactSpec, type CurlSpec } from '@curlviz/core'
import { HISTORY_LIMIT } from './storage'
import type { HistoryEntry, SendOutcome } from '../types'

/**
 * 「把一条历史记录 / 集合里存的条目取回编辑器」这件事的策略。
 *
 * 为什么要单独一层：M2 之后条目可能是脱敏副本（历史默认脱敏、分享码可能带脱敏版进来）。
 * 直接把 `••••••••` 当真实凭据填回编辑区，用户点发送拿到 401，然后开始怀疑接口坏了 ——
 * 这是本工具最难自查的坑，所以取回的那一刻必须说一句。
 */

/** 取回时该不该提示"凭据是遮盖态"。不敏感或本来就带真凭据时返回 null，不啰嗦。 */
export function redactionNoteOnOpen(spec: CurlSpec, markedRedacted = false): string | null {
  if (!markedRedacted && !hasRedactedValues(spec)) return null
  return `这条里带着被抹掉的凭据（${REDACTED_MASK}），要自己填回真实值再发，直接发大概会 401。`
}

export interface HistoryPick {
  /** 交给编辑器的副本：与历史条目里的对象**不是同一个**，改它不会动历史。 */
  spec: CurlSpec
  note: string | null
}

/**
 * 从历史记录取回一条请求。
 *
 * 一定要 cloneSpec：历史里存的 spec 和编辑器里的是同一份引用的话，
 * 用户改个 URL 就把历史列表里那条一起改了，"上次发出去到底是什么"这条线索就没了。
 */
export function entryForEditor(entry: HistoryEntry): HistoryPick {
  const spec = cloneSpec(entry.spec)
  return { spec, note: redactionNoteOnOpen(spec, entry.redacted) }
}

/* ------------------------------------------------------------------ */
/* 发送完写一条历史                                                     */
/* ------------------------------------------------------------------ */

/**
 * 这三件事原来内联在 App 的发送回调里。搬出来的理由不是"整洁"：
 * `hasSensitive(spec)` 当时被调了两遍（一遍决定存明文还是脱敏、一遍决定 redacted 标记），
 * 只要有人改动其中一处，历史里就会出现"存的是明文、标记写着脱敏"的自相矛盾条目 ——
 * 而这种条目取回编辑器时该不该提示、导出时该不该再脱敏，全都跟着错。
 */

/** 发送结果压成历史列表那一行摘要：成功给状态码与耗时，失败给一句话原因。 */
export function resultFromOutcome(outcome: SendOutcome): HistoryEntry['result'] {
  return outcome.ok
    ? { status: outcome.response.status, ok: outcome.response.ok, ms: outcome.response.totalMs }
    : { error: outcome.failure.message }
}

export interface HistoryEntryInput {
  spec: CurlSpec
  sentAt: number
  /** id 由调用方给，为的是这个函数是纯的、可断言（原来是 Math.random 拼串）。 */
  id: string
  /** 用户的「历史脱敏」开关。 */
  redactHistory: boolean
  result: HistoryEntry['result']
}

/**
 * 组装一条历史。脱敏后的 spec 与 `redacted` 标记出自同一次判断。
 *
 * 不脱敏时存的也是 cloneSpec —— 不是洁癖：不副本的话编辑器后续 patch 会顺着引用
 * 把历史条目一起改掉，"这条上次发出去长什么样"的线索就没了。
 */
export function makeHistoryEntry(input: HistoryEntryInput): HistoryEntry {
  const redact = input.redactHistory && hasSensitive(input.spec)
  return {
    id: input.id,
    at: input.sentAt,
    spec: redact ? redactSpec(input.spec) : cloneSpec(input.spec),
    redacted: redact,
    result: input.result
  }
}

/** 新的插到最前面，超过上限的从尾巴上掉。 */
export function appendHistory(old: HistoryEntry[], entry: HistoryEntry, limit = HISTORY_LIMIT): HistoryEntry[] {
  return [entry, ...old].slice(0, limit)
}
