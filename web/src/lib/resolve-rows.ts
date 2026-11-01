import type { ResolveEntry } from '@curlviz/core'

/**
 * 「指定解析」（--resolve host:port:addr）表格的"永远有一行可填"算术。
 *
 * 与 kv-rows 同一取向，只是这里把「端口」从用户要填的字段里拿掉了：
 * curl 的 --resolve 三段都必需，但常态下 host 与端口就等于请求 URL 里的，
 * 用户真正要决定的只有那个 IP。所以新行的 host/端口由 URL 打底（见 urlAuthority），
 * addr（IP）才是"这行算不算真数据"的触发字段。组件只负责画，判错会真丢数据，抽成纯函数单测。
 */

/** 空白草稿：三格皆空。端口 0 视作"未定"（打底时会被 URL 端口覆盖）。 */
export const BLANK_RESOLVE: ResolveEntry = { host: '', port: 0, addr: '' }

/**
 * 末尾要不要**再**补一行空白草稿。空表要；末行还没填 IP（addr 为空）就不要——那行本身就是草稿。
 *
 * 只看 addr：host/端口是打底脚手架，光有它们没 IP 的行是"正在填"的半截行，不该另起一格；
 * 一旦填上 IP，这行才成为真数据，下面再长一格草稿。与键值表「值填没填」同一取向。
 */
export function needsDraftResolveRow(rows: ResolveEntry[]): boolean {
  const last = rows[rows.length - 1]
  return last === undefined || last.addr !== ''
}

/**
 * 把一次编辑落到第 index 行。index 落在真实行之外，说明动的是那行草稿 —— 追加，不是改。
 * 追加时 patch 没给的字段沿用 seed（默认空白草稿；面板会传"host/端口来自 URL"的 seed 进来），
 * 所以"先敲域名再回头填 IP"也不会冒出端口不明的行。
 */
export function applyResolveEdit(
  rows: ResolveEntry[],
  index: number,
  patch: Partial<ResolveEntry>,
  seed: ResolveEntry = BLANK_RESOLVE
): ResolveEntry[] {
  if (index < rows.length) return rows.map((r, k) => (k === index ? { ...r, ...patch } : r))
  return [...rows, { ...seed, ...patch }]
}

export interface UrlAuthority {
  host: string
  port: number
}

/**
 * 从请求 URL 取「域名 + 端口」，给指定解析面板的新行打底。
 *
 * 端口规则与 curl 实际连的端口一致：URL 显式写了就用写的，没写按 scheme 默认（http→80 / 其余→443）。
 * 解析不动（空串、含 {{占位符}}、缺 scheme）时返回 {host:'', port:443}：
 * 端口兜 443 是因为 --resolve 三段里端口不能空，而绝大多数"钉 IP"用法是 https；
 * host 兜空串，交给用户手敲或 placeholder 提示，不硬编一个假域名进去。
 */
export function urlAuthority(url: string): UrlAuthority {
  const trimmed = url.trim()
  if (trimmed === '') return { host: '', port: 443 }
  try {
    const u = new URL(trimmed)
    const schemePort = u.protocol === 'http:' ? 80 : 443
    const explicit = u.port === '' ? NaN : Number(u.port)
    const port = Number.isFinite(explicit) ? explicit : schemePort
    // 模板占位符（{{host}}）别拿去打底：预填一个待替换的变量当域名会把人绕晕，留空让用户自己敲
    const host = u.hostname.includes('{') || u.hostname.includes('}') ? '' : u.hostname
    return { host, port }
  } catch {
    return { host: '', port: 443 }
  }
}
