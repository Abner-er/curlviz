import { REDACTED_MASK, cloneSpec, hasRedactedValues, type CurlSpec } from '@curlviz/core'
import type { HistoryEntry } from '../types'

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
