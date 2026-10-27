import {
  buildUrlWithQuery,
  bytesToBase64,
  generateCurl,
  resolveSpec,
  type CurlSpec,
  type GenerateOptions,
  type VarMap
} from '@curlviz/core'
import type { Param2, SendReport, SentResponse } from '../types'
import { assessCors, corsFailureHint, corsPreSendNotice, FORBIDDEN_REQUEST_HEADERS } from './fetch-rules'
import { classifyBody, decodeBody, MAX_PREVIEW_BYTES, truncateBytes } from './response'

const MAX_LIMIT = MAX_PREVIEW_BYTES

/** 跨域时浏览器只暴露这几个响应头，其余读不到——不是 bug，是 CORS 规范。 */
const SAFELISTED_RESPONSE_HEADERS = [
  'cache-control',
  'content-language',
  'content-type',
  'expires',
  'last-modified',
  'pragma'
]

/**
 * fetch 会静默丢弃的头（Fetch 标准的 forbidden header name 列表）。
 * 不写出来的话，用户会以为自己的 Cookie / Host 发出去了，实际没有——这类"看着对其实没发"
 * 是最坑的，必须显式列出来告诉用户。
 * 表本体在 lib/fetch-rules.ts：那边算"会不会触发预检"要用同一份清单（被丢弃的头不上线，
 * 也就不触发预检），两处各写一份迟早会漂。
 */

export interface SendDeps {
  vars?: VarMap
  generate?: GenerateOptions
  /** 可注入以便测试；默认用全局 fetch。 */
  fetchImpl?: typeof fetch
  now?: () => number
  timeoutMs?: number
  signal?: AbortSignal
}

/** 由 spec 造出 fetch 的入参，纯函数，可单测。 */
export function buildRequest(
  spec: CurlSpec,
  vars: VarMap = {},
  base = ''
): {
  url: string
  init: RequestInit
  blockedHeaders: string[]
  notes: string[]
  hasBody: boolean
  filePartBlocked: boolean
} {
  const notes: string[] = []
  const blockedHeaders: string[] = []

  const url = absolutize(buildUrlWithQuery(spec.url, spec.query), base)

  const headers: [string, string][] = []
  const seen = new Set<string>()
  const push = (name: string, value: string): void => {
    const lower = name.toLowerCase()
    if (seen.has(lower)) return
    seen.add(lower)
    if (FORBIDDEN_REQUEST_HEADERS.has(lower)) {
      blockedHeaders.push(name)
      return
    }
    headers.push([name, value])
  }

  for (const h of spec.headers) if (h.enabled && h.key.trim() !== '') push(h.key.trim(), h.value)

  if (spec.auth.type === 'basic') {
    const b = spec.auth.basic
    const raw = new TextEncoder().encode(`${b.username}:${b.password}`)
    push('Authorization', `Basic ${bytesToBase64(raw)}`)
  } else if (spec.auth.type === 'bearer') {
    if (spec.auth.bearer.token.trim() !== '') push('Authorization', `Bearer ${spec.auth.bearer.token}`)
  }

  let uaPreflightPending = false
  if (spec.options.userAgent.trim() !== '') {
    // User-Agent 不在 forbidden 列表里，能设；但会让跨域请求多一次预检
    push('User-Agent', spec.options.userAgent)
    uaPreflightPending = true
  }

  const bodyResult = buildBody(spec, push)
  if (bodyResult.note) notes.push(bodyResult.note)

  const init: RequestInit = {
    method: spec.method.toUpperCase() === 'GET' && !bodyResult.hasBody ? 'GET' : spec.method.toUpperCase(),
    headers,
    redirect: spec.options.followRedirects ? 'follow' : 'manual',
    credentials: 'omit',
    body: bodyResult.body
  }

  if (spec.options.insecure) notes.push('浏览器的证书校验不可关（-k 无效）；内网自签证书请先让系统信任，或走本地 agent。')
  if (spec.options.connectTimeoutMs > 0) notes.push('浏览器不能单独设建连超时，只有总时限（-m）生效。')
  if (spec.options.proxy.trim() !== '') notes.push('浏览器 fetch 不能指定代理（-x 无效），请走系统/浏览器代理或本地 agent。')
  if (spec.options.compressed) notes.push('--compressed 在这里不需要：浏览器总带 gzip/br 并自动解压。')

  // 三条"浏览器做不到"的实话。都不算 bug，是 fetch 与 curl 的边界，但用户看不见就等于骗他。
  const emptyHeaders = spec.headers.filter((h) => h.enabled && h.value === '' && h.key.trim() !== '')
  if (emptyHeaders.length > 0) {
    notes.push(
      `${emptyHeaders.map((h) => `-H '${h.key}:'`).join(' ')} 在 curl 里是"删掉这个头"（实测连 curl 自带的 Accept / User-Agent 都删得掉），` +
        '而 fetch 没有等价操作：自定义头会带着空值发出去，浏览器禁止脚本设的头（Cookie / Referer 等）则是整个忽略 —— 两种都不是"不发这行"。' +
        '要真删请用「复制到终端」跑 curl。'
    )
  }
  if (spec.rawArgs.length > 0) {
    const shown = spec.rawArgs.slice(0, 3).join(' ') + (spec.rawArgs.length > 3 ? ' …' : '')
    notes.push(
      `「选项」页里原样保留的 ${spec.rawArgs.length} 个 flag（${shown}）浏览器发送不会执行，` +
        '只有「复制到终端」跑 curl 才生效。'
    )
  }
  const viaUrlQuery = spec.query.filter((p) => p.enabled && p.viaUrlQuery === true)
  if (viaUrlQuery.length > 0) {
    notes.push(
      `其中 ${viaUrlQuery.length} 项来自 --url-query：浏览器发送只能把它们折进 URL，编码用 encodeURIComponent` +
        '（空格编成 %20）；而 curl 自己的表把空格编成 +、! 编成 %21。复制到终端的那条仍然逐条写 --url-query，由 curl 编码。'
    )
  }

  // 第四条：跨域。预检要不要发是能算的（Fetch 标准），对方答不答应不能算——文案只说前者，别冒充后者。
  const corsRisk = assessCors(spec, base)
  const corsNote = corsPreSendNotice(corsRisk)
  if (corsNote !== '') notes.push(corsNote)
  // 跨域判定成立时，user-agent 已经作为触发点写进上面那条了，这里不再重复；
  // 只在"同源 / base 取不到"（也就是判定帮不上忙）时，才补一句假设性的提醒。
  if (uaPreflightPending && corsRisk === null) {
    notes.push('设置 -A 会让跨域请求多一次 OPTIONS 预检，对方服务没处理预检就会失败。')
  }

  return {
    url,
    init,
    blockedHeaders,
    notes,
    hasBody: bodyResult.hasBody,
    filePartBlocked: bodyResult.filePartBlocked
  }
}

function buildBody(
  spec: CurlSpec,
  push: (name: string, value: string) => void
): { body: BodyInit | null; hasBody: boolean; note?: string; filePartBlocked: boolean } {
  const b = spec.body
  switch (b.type) {
    case 'none':
      return { body: null, hasBody: false, filePartBlocked: false }
    case 'json': {
      if (b.json.trim() === '') return { body: null, hasBody: false, filePartBlocked: false }
      push('Content-Type', 'application/json')
      return { body: b.json, hasBody: true, filePartBlocked: false }
    }
    case 'form': {
      const items = b.form.filter((f) => f.enabled && f.key.trim() !== '')
      if (items.length === 0) return { body: null, hasBody: false, filePartBlocked: false }
      const text = items.map((f) => `${encodeURIComponent(f.key)}=${encodeURIComponent(f.value)}`).join('&')
      push('Content-Type', 'application/x-www-form-urlencoded')
      return { body: text, hasBody: true, filePartBlocked: false }
    }
    case 'raw':
      if (b.raw === '') return { body: null, hasBody: false, filePartBlocked: false }
      return { body: b.raw, hasBody: true, filePartBlocked: false }
    case 'multipart': {
      const items = b.multipart.filter((m) => m.enabled && m.key.trim() !== '')
      if (items.length === 0) return { body: null, hasBody: false, filePartBlocked: false }
      const hasFile = items.some((m) => m.kind === 'file')
      const fd = new FormData()
      for (const m of items) {
        if (m.kind === 'file') {
          // 浏览器拿不到本地路径对应的文件（安全边界），只能让用户手动挑或走 agent
          continue
        }
        fd.append(m.key, m.value)
      }
      // 注意：这里绝不要自己设 Content-Type，FormData 会带上 boundary；设了反而坏请求
      return {
        body: fd,
        hasBody: true,
        filePartBlocked: hasFile,
        note: hasFile
          ? 'multipart 的文件字段（@路径）浏览器读不到本地文件，已只发文本字段；要发文件请用「复制到终端」或本地 agent。'
          : undefined
      }
    }
    default:
      return { body: null, hasBody: false, filePartBlocked: false }
  }
}

/** 相对 URL 在浏览器里也能发，但要拼上当前 origin 才是完整地址。 */
function absolutize(url: string, base: string): string {
  if (/^[a-z][a-z0-9+.-]*:/i.test(url) || url.startsWith('//')) return url
  if (!base) return url
  try {
    return new URL(url, base).toString()
  } catch {
    return url
  }
}

function mixedContent(pageBase: string, target: string): boolean {
  if (!pageBase.startsWith('https://')) return false
  return target.startsWith('http://')
}

async function readCapped(
  response: Response,
  max: number
): Promise<{ bytes: Uint8Array; total: number | null; sizeExact: boolean }> {
  const declared = Number(response.headers.get('content-length'))
  const total = Number.isFinite(declared) && declared > 0 ? declared : null

  if (!response.body) {
    const buf = await response.arrayBuffer()
    return { bytes: new Uint8Array(buf), total, sizeExact: true }
  }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let received = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (value) {
      chunks.push(value)
      received += value.length
      // 超上限就断流：不该为了"看看响应"把 200MB 拖进浏览器
      if (received > max) {
        await reader.cancel()
        return { bytes: concat(chunks, received), total: total ?? received, sizeExact: false }
      }
    }
  }
  return { bytes: concat(chunks, received), total, sizeExact: true }
}

function concat(chunks: Uint8Array[], size: number): Uint8Array {
  const out = new Uint8Array(size)
  let at = 0
  for (const c of chunks) {
    out.set(c, at)
    at += c.length
  }
  return out
}

function collectHeaders(response: Response, corsLimited: boolean): Param2[] {
  const list: Param2[] = []
  response.headers.forEach((value, name) => list.push({ name, value }))
  if (corsLimited && list.length <= SAFELISTED_RESPONSE_HEADERS.filter((h) => response.headers.has(h)).length) {
    // 跨域时只剩安全清单那几个头，如实告诉用户不是"服务端没回头"
    list.push({ name: '(受限)', value: '跨域响应头由浏览器按 CORS 规则过滤，只有安全清单里那几个能读到' })
  }
  return list
}

/** 发送一条 spec。不抛错，所有失败都变成 SendOutcome 里的诚实说明。 */
export async function sendSpec(
  spec: CurlSpec,
  deps: SendDeps & { pageBase?: string } = {}
): Promise<SendReport> {
  const vars: VarMap = deps.vars ?? {}
  const resolved = resolveSpec(spec, vars)
  const now = deps.now ?? (() => performance.now())
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch.bind(globalThis)
  const pageBase = deps.pageBase ?? globalThis.location?.href ?? ''

  const built = buildRequest(resolved.spec, vars, pageBase)
  const curl = generateCurl(spec, deps.generate)

  const controller = new AbortController()
  const timers: ReturnType<typeof setTimeout>[] = []
  const outerSignal = deps.signal
  const onOuterAbort = (): void => controller.abort(new DOMException('已取消', 'AbortError'))
  if (outerSignal) {
    if (outerSignal.aborted) onOuterAbort()
    else outerSignal.addEventListener('abort', onOuterAbort)
  }
  const timeoutMs = deps.timeoutMs ?? resolved.spec.options.timeoutMs
  if (timeoutMs > 0) {
    timers.push(
      setTimeout(() => controller.abort(new DOMException(`超过 ${timeoutMs} ms 总时限，已断开`, 'TimeoutError')), timeoutMs)
    )
  }

  const sentAt = Date.now()
  const t0 = now()
  try {
    if (mixedContent(pageBase, built.url)) {
      return {
        outcome: {
          ok: false,
          failure: {
            kind: 'mixed-content',
            message: '页面是 https，目标是 http，浏览器会直接拦掉这种混合内容请求。',
            hint: '改用 http 打开本页面（本地工具本来就在内网），或复制到终端里发。',
            raw: `${pageBase} -> ${built.url}`
          }
        },
        unresolved: resolved.unresolved,
        blockedHeaders: built.blockedHeaders,
        notes: built.notes,
        curl,
        sentAt
      }
    }

    const response = await fetchImpl(built.url, { ...built.init, signal: controller.signal })
    const ttfbMs = now() - t0

    const { bytes, total, sizeExact } = await readCapped(response, MAX_LIMIT)
    const totalMs = now() - t0
    const capped = truncateBytes(bytes, total, MAX_LIMIT)
    const contentType = response.headers.get('content-type') ?? ''
    const text = capped.bytes.length > 0 && !isImageish(contentType) ? decodeBody(capped.bytes, contentType) : ''

    const sent: SentResponse = {
      status: response.status,
      statusText: response.statusText,
      ok: response.ok,
      headers: collectHeaders(response, response.type === 'cors' || response.type === 'opaque'),
      contentType,
      bytes: capped.bytes,
      totalBytes: capped.totalBytes,
      sizeExact,
      truncated: capped.truncated,
      text,
      kind: classifyBody(contentType, text, capped.bytes),
      ttfbMs,
      totalMs
    }
    return {
      outcome: { ok: true, response: sent },
      unresolved: resolved.unresolved,
      blockedHeaders: built.blockedHeaders,
      notes: built.notes,
      curl,
      sentAt
    }
  } catch (e) {
    const err = e as { name?: string; message?: string }
    const message = err.message ?? String(e)
    const failure =
      err.name === 'AbortError'
        ? {
            kind: 'abort' as const,
            message: '已取消这次请求。',
            hint: '需要重跑就再点一次发送。'
          }
        : err.name === 'TimeoutError'
          ? {
              kind: 'timeout' as const,
              message: `超过 ${timeoutMs} ms 还没拿到响应，已断开。`,
              hint: '把「选项 → 总时限」放宽，或用 -v 的等价物（复制到终端）看它卡在建连还是在等响应。',
              raw: message
            }
          : {
              kind: 'blocked-or-network' as const,
              message: '请求没能完成。',
              hint: corsFailureHint(assessCors(resolved.spec, pageBase)),
              raw: message
            }
    return {
      outcome: { ok: false, failure },
      unresolved: resolved.unresolved,
      blockedHeaders: built.blockedHeaders,
      notes: built.notes,
      curl,
      sentAt
    }
  } finally {
    for (const t of timers) clearTimeout(t)
    if (outerSignal) outerSignal.removeEventListener('abort', onOuterAbort)
  }
}

function isImageish(ct: string): boolean {
  return ct.toLowerCase().startsWith('image/')
}

/**
 * sendSpec 按设计不抛错，失败都编进 SendOutcome。真抛了就是环境级故障
 * （`globalThis.fetch` 取不到、构造 Request 时浏览器直接拒绝这类），
 * 界面不能因此什么都不显示、把上一次的结果继续挂在那儿。
 *
 * 不复用 blocked-or-network：那一类说的是"这条请求没出去，去查 CORS / 服务通不通"，
 * 而这里查接口没有任何意义 —— 该做的是刷新页面。归错类会把人引到错误的排查方向上，
 * 对这个工具来说比不报错更糟。
 */
export function toolFailureReport(e: unknown, curl: string, sentAt: number): SendReport {
  return {
    outcome: {
      ok: false,
      failure: {
        kind: 'tool-error',
        message: `工具自己出错了：${String(e)}`,
        hint: '这不是接口的问题，是页面本身不对劲。刷新一次再试；还是这样就用「复制到终端」在本机跑 curl。',
        raw: e instanceof Error ? (e.stack ?? e.message) : String(e)
      }
    },
    unresolved: [],
    blockedHeaders: [],
    notes: [],
    curl,
    sentAt
  }
}
