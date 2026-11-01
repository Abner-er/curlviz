import type { ResolveEntry } from '@curlviz/core'

/**
 * 「指定解析」（--resolve）表格的"永远有一行可填"算术。
 *
 * 与 kv-rows 同一套判据，只是从两格扩到三格（host / 端口 / addr）：
 * 组件只负责把结果画出来，"末行算不算草稿、编辑落在越界位置该追加还是该改"
 * 这两件事判错了会真的丢数据，所以抽成脱离 DOM 的纯函数单测。
 */

/** 空白草稿：三格全空。端口 0 在表单里显示为空（见 Editors 的端口输入）。 */
export const BLANK_RESOLVE: ResolveEntry = { host: '', port: 0, addr: '' }

/**
 * 末尾要不要**再**补一行空白草稿。空表要；末行三格全空（host、addr 皆空且端口 0）就不要——那行本身就是草稿。
 *
 * 判"空白"看的是三格**都**没东西：只填了端口没填 host/addr 的行是半截真数据（下面另起一格草稿），
 * 与键值表里「只 key 空的行是真数据（-H 'K:' 是删头）」同一取向。
 */
export function needsDraftResolveRow(rows: ResolveEntry[]): boolean {
  const last = rows[rows.length - 1]
  return last === undefined || last.host !== '' || last.addr !== '' || last.port !== 0
}

/**
 * 把一次编辑落到第 index 行。index 落在真实行之外，说明动的是那行草稿 —— 追加，不是改。
 * 追加时 patch 没给的字段沿用空白草稿的默认（端口 0），所以"先填 IP 再回头补 host"也不会冒出端口不明的行。
 */
export function applyResolveEdit(
  rows: ResolveEntry[],
  index: number,
  patch: Partial<ResolveEntry>
): ResolveEntry[] {
  if (index < rows.length) return rows.map((r, k) => (k === index ? { ...r, ...patch } : r))
  return [...rows, { ...BLANK_RESOLVE, ...patch }]
}
