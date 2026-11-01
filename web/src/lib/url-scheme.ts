/**
 * 地址栏协议自动补齐：运维要的是"少敲字"，`https://` 这种前缀每次手敲纯属浪费。
 *
 * 规则（都可被用户手改覆盖 —— 只在失焦那一刻兜底，绝不拦着人把协议删掉或换成 http）：
 *  - 空串原样返回（交给占位符说话，别把 `https://` 塞进空框当默认值吓用户）。
 *  - 已经带协议（`^[a-z][a-z0-9+.-]*://`，含相对协议 `//host` 以外的）→ 不越权改。
 *  - 开头是 `{{变量}}` → 原样返回：整段变量很可能就是"含协议的 base"（`{{api_base}}/v1`），
 *    我们猜协议反而会把 `http://host` 变成 `https://http://host` 这种坏值。
 *  - `//host/path`（相对协议）→ 只补 scheme，保留后面的 `//`。
 *  - 其余（`host`、`host/path`、`localhost:8080/x`）→ 补 `<scheme>://`。
 */
export const DEFAULT_SCHEME = 'https'

const SCHEMED = /^[a-z][a-z0-9+.-]*:\/\//i

export function ensureScheme(url: string, scheme: string = DEFAULT_SCHEME): string {
  const t = url.trim()
  if (t === '') return url
  if (t.startsWith('{{')) return url
  if (SCHEMED.test(t)) return url
  if (t.startsWith('//')) return `${scheme}:${t}`
  return `${scheme}://${t}`
}

/** 有没有协议（相对协议 `//host` 也算没有，因为缺 scheme 浏览器 fetch 会当场拼成页面源）。 */
export function hasScheme(url: string): boolean {
  return SCHEMED.test(url.trim())
}
