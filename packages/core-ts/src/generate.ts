/**
 * CurlSpec → curl 命令（生成方向）。
 *
 * 目标只有一个：**复制到终端能直接跑**。所以：
 *   - 变量 `{{name}}` 绝不能被 percent-encode（`%7B%7Btoken%7D%7D` 是坏命令），
 *     所有编码函数都走"变量段原样、其余编码"。
 *   - 引号风格分 posix / windows：`'\''` 是 shell 语法，cmd.exe 不认，Windows 用户
 *     必须切双引号风格，否则带引号的 JSON body 一定坏。
 *   - auth 与 headers 互斥：auth.type ≠ none 时，同名 Authorization 头不再重复输出，
 *     否则 curl 会发两个认证头。
 */

import type { CurlSpec, MultipartParam, Param, RequestOptions } from './types'
import type { GenerateOptions, QuoteStyle } from './types'

const VAR_RE = /\{\{\s*[\w.-]+\s*\}\}/g

/** 变量段原样保留，其余按 percent-encode。 */
export function encodeKeepingVars(text: string): string {
  let out = ''
  let last = 0
  for (const m of text.matchAll(VAR_RE)) {
    const idx = m.index ?? 0
    out += encodeURIComponent(text.slice(last, idx))
    out += m[0]
    last = idx + m[0].length
  }
  out += encodeURIComponent(text.slice(last))
  return out
}

/** 只裁掉首尾空白，不做编码（用于 header 值等原样透出的位置）。 */
export function buildUrlWithQuery(url: string, query: Param[]): string {
  const active = query.filter((q) => q.enabled && q.key !== '')
  if (active.length === 0) return url
  const qs = active.map((q) => `${encodeKeepingVars(q.key)}=${encodeKeepingVars(q.value)}`).join('&')
  return url.includes('?') ? `${url}&${qs}` : `${url}?${qs}`
}

function quotePosix(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

function quoteWindows(value: string): string {
  // cmd.exe：外层双引号，内部 " 转义成 \"，% 双写成 %% 会被 curl 当字面量即可
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

function makeQuoter(style: QuoteStyle): (value: string) => string {
  return style === 'windows' ? quoteWindows : quotePosix
}

/** 单条 `-H 'K: V'`。空值走 `K:` 形态（curl 语义为发送空头）。 */
function headerArg(h: Param, q: (v: string) => string): string {
  const value = h.value === '' ? `${h.key}:` : `${h.key}: ${h.value}`
  return `-H ${q(value)}`
}

function bodyArgs(spec: CurlSpec, q: (v: string) => string): { args: string[]; autoContentType: string | null } {
  const { body } = spec
  switch (body.type) {
    case 'none':
      return { args: [], autoContentType: null }
    case 'json': {
      const json = body.json.trim()
      if (json === '') return { args: [], autoContentType: null }
      const has = spec.headers.some((h) => h.enabled && h.key.toLowerCase() === 'content-type')
      return { args: [`--data-raw ${q(json)}`], autoContentType: has ? null : 'application/json' }
    }
    case 'form': {
      const active = body.form.filter((f) => f.enabled && f.key !== '')
      if (active.length === 0) return { args: [], autoContentType: null }
      const encoded = active
        .map((f) => `${encodeKeepingVars(f.key)}=${encodeKeepingVars(f.value)}`)
        .join('&')
      return { args: [`-d ${q(encoded)}`], autoContentType: null }
    }
    case 'multipart': {
      const active = body.multipart.filter((m) => m.enabled && m.key !== '')
      if (active.length === 0) return { args: [], autoContentType: null }
      return {
        args: active.map((m) => `${multipartFlag(m)} ${q(multipartValue(m))}`),
        autoContentType: null
      }
    }
    case 'raw': {
      const raw = body.raw
      if (raw === '') return { args: [], autoContentType: null }
      return { args: [`--data-binary ${q(raw)}`], autoContentType: null }
    }
    default:
      return { args: [], autoContentType: null }
  }
}

/**
 * 选 `-F` 还是 `--form-string`。
 * curl 的 `-F` 会解析 `@file`、`<file`、`;type=`、`;filename=`；
 * 文本字段的值里一旦出现这些形态，用 `-F` 就等于把数据改写成指令，必须退回 `--form-string`。
 */
function multipartFlag(m: MultipartParam): string {
  if (m.kind === 'file') return '-F'
  const v = m.value
  if (v.includes(';') || v.startsWith('@') || v.startsWith('<')) return '--form-string'
  return '-F'
}

function multipartValue(m: MultipartParam): string {
  if (m.kind === 'text') return `${m.key}=${m.value}`
  const parts = [`${m.key}=@${m.value}`]
  if (m.filename) parts.push(`filename=${m.filename}`)
  if (m.contentType) parts.push(`type=${m.contentType}`)
  return parts.join(';')
}

function authArgs(spec: CurlSpec, q: (v: string) => string): string[] {
  if (spec.auth.type === 'basic') {
    const { username, password } = spec.auth.basic
    if (username === '' && password === '') return []
    return [`-u ${q(`${username}:${password}`)}`]
  }
  if (spec.auth.type === 'bearer') {
    const token = spec.auth.bearer.token
    if (token === '') return []
    return [`-H ${q(`Authorization: Bearer ${token}`)}`]
  }
  return []
}

function optionArgs(o: RequestOptions, q: (v: string) => string): string[] {
  const out: string[] = []
  if (o.followRedirects) out.push('-L')
  if (o.insecure) out.push('-k')
  if (o.compressed) out.push('--compressed')
  // timeoutMs 是总时限 → -m；connectTimeoutMs 才是 --connect-timeout。见 PLAN 附录 A 勘误
  if (o.timeoutMs > 0) out.push(`-m ${msToSeconds(o.timeoutMs)}`)
  if (o.connectTimeoutMs > 0) out.push(`--connect-timeout ${msToSeconds(o.connectTimeoutMs)}`)
  if (o.userAgent !== '') out.push(`-A ${q(o.userAgent)}`)
  if (o.proxy !== '') out.push(`-x ${q(o.proxy)}`)
  return out
}

function msToSeconds(ms: number): string {
  const s = ms / 1000
  return Number.isInteger(s) ? String(s) : String(Number(s.toFixed(3)))
}

/**
 * 生成 curl 命令。
 * 输出顺序：curl URL → 方法 → 选项 → headers → auth → body → rawArgs，
 * 与主流工具习惯一致，diff 友好。
 */
export function generateCurl(spec: CurlSpec, opts?: GenerateOptions): string {
  const style: QuoteStyle = opts?.quoteStyle ?? 'posix'
  const multiline = opts?.multiline ?? true
  const indent = opts?.indent ?? '  '
  const mergeQuery = opts?.mergeQueryIntoUrl ?? true
  const q = makeQuoter(style)

  const url = mergeQuery ? buildUrlWithQuery(spec.url, spec.query) : spec.url
  const parts: string[] = []

  // HEAD 用 -I 而不是 -X HEAD：两者发出的请求完全一样，但 `-X HEAD` 会让 curl
  // 一直等一个永远不会来的响应体（社区公认的坑），看起来像命令卡死。
  // CurlSpec 表达不了"等不等 body"这个区别，所以统一取不卡死的那个写法。
  const method = spec.method.toUpperCase()
  if (method === 'HEAD') parts.push('-I')
  else if (method !== 'GET') parts.push(`-X ${method}`)
  parts.push(...optionArgs(spec.options, q))

  const headers = spec.headers.filter(
    (h) => h.enabled && !(spec.auth.type !== 'none' && h.key.toLowerCase() === 'authorization')
  )
  for (const h of headers) parts.push(headerArg(h, q))

  parts.push(...authArgs(spec, q))

  const body = bodyArgs(spec, q)
  if (body.autoContentType) {
    parts.push(headerArg({ key: 'Content-Type', value: body.autoContentType, enabled: true }, q))
  }
  parts.push(...body.args)

  for (const raw of spec.rawArgs) parts.push(raw)

  const urlToken = url === '' ? "''" : q(url)
  const segments = [`curl ${urlToken}`, ...parts]

  if (opts?.withNameComment && spec.name) segments.unshift(`# ${spec.name}`)

  if (!multiline) return segments.join(' ')

  const lastIndex = segments.length - 1
  let commandLineSeen = false
  return segments
    .map((seg, i) => {
      // 注释行不带续行符：它不是命令的一部分，接 ` \` 会让 bash 把下一行并进注释的延续里
      const withCont = i === lastIndex || seg.startsWith('#') ? seg : `${seg} \\`
      if (seg.startsWith('#')) return withCont
      // 命令行首行必须顶格；开了 withNameComment 时它就是第一条非注释段
      const isCommandHead = !commandLineSeen
      commandLineSeen = true
      return isCommandHead ? withCont : `${indent}${withCont}`
    })
    .join('\n')
}

/** 只取续行后的整洁版本（供 UI 直接展示）。 */
export function generateCurlMultiline(spec: CurlSpec, opts?: Omit<GenerateOptions, 'multiline'>): string {
  return generateCurl(spec, { ...opts, multiline: true })
}

export function generateCurlSingleLine(spec: CurlSpec, opts?: Omit<GenerateOptions, 'multiline'>): string {
  return generateCurl(spec, { ...opts, multiline: false })
}
