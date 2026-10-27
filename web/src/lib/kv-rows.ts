/**
 * 键值表的"永远有一行可填"算术。
 *
 * 放 lib 是为了能脱离 DOM 单测：组件只负责把结果画出来，
 * 而"哪一行算草稿、编辑落在越界位置时该追加还是该改"这两件事判错了会真的丢数据。
 */

/** 草稿行只看这两个字段，其余（enabled / kind）按各表自己的默认 */
interface Keyed {
  key: string
  value: string
}

/**
 * 末尾要不要**再**补一行空白草稿。空表要；末行两个字段都空就不要（那行本身就是草稿）。
 *
 * "空"判的是 key 与 value **都**空，不是"只 key 空"：headers 表里 `{key:'Accept', value:''}`
 * 是 `-H 'Accept:'`，实测语义是**删掉这个头**，那是真数据，不能当草稿吃掉。
 */
export function needsDraftRow(rows: Keyed[]): boolean {
  const last = rows[rows.length - 1]
  return last === undefined || last.key !== '' || last.value !== ''
}

/**
 * 把一次编辑落到第 index 行。index 落在真实行之外面，说明动的是那行草稿 —— 追加，不是改。
 *
 * 追加时 patch 里没给的字段沿用 blank 的默认（比如 multipart 的 `kind:'text'`），
 * 所以"先在值里打字、再回头填名字"也不会冒出一个 kind 不明的行。
 */
export function applyRowEdit<T extends Keyed>(rows: T[], index: number, blank: T, patch: Partial<T>): T[] {
  if (index < rows.length) return rows.map((r, k) => (k === index ? { ...r, ...patch } : r))
  return [...rows, { ...blank, ...patch }]
}
