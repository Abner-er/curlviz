/**
 * agent transport：把一条已解析的 spec 交给用户自己的 ECS 上跑真 curl，
 * 拿回**同形 SendReport**，响应视图一行不改（spec/README.md §13）。
 *
 * 与浏览器路径的分工：`http.ts` 走 fetch、只发「浏览器能发的部分」；这里把完整 spec
 * POST 给 agent，agent 用 argv 起真 curl（-k / --resolve / rawArgs 都生效）。两条路都
 * 不抛错，失败一律编进 SendReport 的 failure，界面统一渲染。
 *
 * 纯映射（toSentResponse / buildSendReport / readWire）与网络（sendViaAgent）拆开，
 * 前者可用 mock 数据直接单测，**不依赖任何真请求**。
 */

import { base64ToBytes, type ResolveResult } from '@curlviz/core'
import type {
  AgentExecutor,
  FailureKind,
  Param2,
  SendReport,
  SentResponse
} from '../types'
import { classifyBody, decodeBody, MAX_PREVIEW_BYTES, truncateBytes } from './response'

/* ------------------------------------------------------------------ */
/* wire 类型（web 本地镜像；字节格式钉死在 spec/README.md §13）          */
/* ------------------------------------------------------------------ */

export interface AgentWireResponse {
  status: number
  statusText: string
  ok: boolean
  headers: [string, string][]
  contentType: string
  bodyBase64: string
  totalBytes: number
  sizeExact: boolean
  truncated: boolean
  ttfbMs: number
  totalMs: number
}

export interface AgentWireOk {
  ok: true
  response: AgentWireResponse
}

export interface AgentWireFail {
  ok: false
  failure: { kind: string; message: string; hint?: string; raw?: string }
}

export type AgentWire = AgentWireOk | AgentWireFail

export interface AgentSendDeps {
  fetchImpl?: typeof fetch
  now?: () => number
  signal?: AbortSignal
  /** 前端总时限兜底；agent 侧 curl 另有 -m。0=不额外断。 */
  timeoutMs?: number
}

/* ------------------------------------------------------------------ */
/* 纯映射                                                              */
/* ------------------------------------------------------------------ */

/** agent 会返回的失败分类；不在表里的（版本不匹配、乱写）一律降级成 agent-error。 */
const KNOWN_AGENT_FAILURE_KINDS: ReadonlySet<FailureKind> = new Set<FailureKind>([
  'agent-rejected',
  'agent-error',
  'timeout',
  'abort',
  'unreachable'
])

function toFailureKind(kind: string): FailureKind {
  const k = kind as FailureKind
  return KNOWN_AGENT_FAILURE_KINDS.has(k) ? k : 'agent-error'
}

function bytesFromBase64(b64: string): Uint8Array {
  if (b64 === '') return new Uint8Array(0)
  return base64ToBytes(b64) ?? new Uint8Array(0)
}

function isImageish(contentType: string): boolean {
  return contentType.toLowerCase().startsWith('image/')
}

/** wire 的 response → SentResponse：base64 解字节、按类型解码文本、归类渲染。 */
export function toSentResponse(r: AgentWireResponse): SentResponse {
  const raw = bytesFromBase64(r.bodyBase64)
  const capped = truncateBytes(raw, r.totalBytes > 0 ? r.totalBytes : null, MAX_PREVIEW_BYTES)
  const contentType = r.contentType
  const text = capped.bytes.length > 0 && !isImageish(contentType) ? decodeBody(capped.bytes, contentType) : ''
  const headers: Param2[] = r.headers.map((pair) => ({ name: pair[0], value: pair[1] }))
  return {
    status: r.status,
    statusText: r.statusText,
    ok: r.ok,
    headers,
    contentType,
    bytes: capped.bytes,
    totalBytes: Math.max(capped.totalBytes, r.totalBytes),
    sizeExact: r.sizeExact,
    truncated: r.truncated || capped.truncated,
    text,
    kind: classifyBody(contentType, text, capped.bytes),
    ttfbMs: r.ttfbMs,
    totalMs: r.totalMs
  }
}

/** agent 路径的诚实说明：这里就是真 curl，浏览器那些发不出的都照常生效。 */
function agentNotes(executorName: string): string[] {
  return [
    `经「${executorName}」上的真 curl 执行：-k / --resolve / rawArgs 等浏览器 fetch 发不出的都会照常生效（区别于浏览器路径的完全跳过）。`
  ]
}

/** wire（含成功/失败）→ SendReport，纯函数，好单测。 */
export function buildSendReport(
  wire: AgentWire,
  ctx: { curl: string; unresolved: string[]; sentAt: number; executorName: string }
): SendReport {
  const notes = agentNotes(ctx.executorName)
  if (wire.ok) {
    return {
      outcome: { ok: true, response: toSentResponse(wire.response) },
      unresolved: ctx.unresolved,
      blockedHeaders: [],
      notes,
      curl: ctx.curl,
      sentAt: ctx.sentAt
    }
  }
  const f = wire.failure
  return {
    outcome: {
      ok: false,
      failure: { kind: toFailureKind(f.kind), message: f.message, hint: f.hint ?? '', raw: f.raw }
    },
    unresolved: ctx.unresolved,
    blockedHeaders: [],
    notes,
    curl: ctx.curl,
    sentAt: ctx.sentAt
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null
}

/** 轻量结构校验：ok 是布尔；成功时 response.status 必须是数字。 */
export function isAgentWire(v: unknown): v is AgentWire {
  if (!isRecord(v) || typeof v.ok !== 'boolean') return false
  if (v.ok) {
    const r = v.response
    return isRecord(r) && typeof r.status === 'number'
  }
  return isRecord(v.failure) && typeof v.failure.message === 'string'
}

/** 读 body 文本并解析 wire；不合契约就转成 agent-error（不抛）。 */
export async function readWire(res: Response): Promise<AgentWire> {
  const text = await res.text()
  let parsed: unknown
  try {
    parsed = JSON.parse(text) as unknown
  } catch {
    return {
      ok: false,
      failure: {
        kind: 'agent-error',
        message: `agent 返回的不是约定的 JSON（HTTP ${res.status}）`,
        hint: '确认 baseUrl 指向的是 CurlViz agent 的 /exec；也可能是它前面的反代改写了响应。',
        raw: text.slice(0, 500)
      }
    }
  }
  if (!isAgentWire(parsed)) {
    return {
      ok: false,
      failure: {
        kind: 'agent-error',
        message: `agent 返回的 JSON 不合契约（HTTP ${res.status}）`,
        hint: '检查 agent 版本是否与前端匹配。',
        raw: text.slice(0, 500)
      }
    }
  }
  return parsed
}

/* ------------------------------------------------------------------ */
/* 网络：POST /exec                                                    */
/* ------------------------------------------------------------------ */

function execUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/exec`
}

/**
 * 发到 agent。不抛错：网络失败=unreachable，取消=abort，超时=timeout，其余交给 wire 映射。
 * 注意 POST 出去的是**已替换变量**的 spec（agent 侧不再碰 {{}}）。
 */
export async function sendViaAgent(
  resolved: ResolveResult,
  executor: AgentExecutor,
  curl: string,
  deps: AgentSendDeps = {}
): Promise<SendReport> {
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch.bind(globalThis)
  const sentAt = Date.now()
  const controller = new AbortController()
  const timers: ReturnType<typeof setTimeout>[] = []
  const outer = deps.signal
  const onAbort = (): void => controller.abort(new DOMException('已取消', 'AbortError'))
  if (outer) {
    if (outer.aborted) onAbort()
    else outer.addEventListener('abort', onAbort)
  }
  // agent 侧 curl 由 -m 兜底；这里只防 agent 整个卡住不回首，给 -m 之外再加 15s 余量。
  const baseTimeout = deps.timeoutMs ?? resolved.spec.options.timeoutMs
  const clientMs = baseTimeout > 0 ? baseTimeout + 15000 : 0
  if (clientMs > 0) {
    timers.push(
      setTimeout(() => controller.abort(new DOMException(`超过 ${clientMs} ms 没拿到 agent 结果，已断开`, 'TimeoutError')), clientMs)
    )
  }

  try {
    const headers: Record<string, string> = { 'content-type': 'application/json' }
    if (executor.token.trim() !== '') headers['x-curlviz-token'] = executor.token
    const res = await fetchImpl(execUrl(executor.baseUrl), {
      method: 'POST',
      headers,
      body: JSON.stringify({ v: 1, spec: resolved.spec }),
      signal: controller.signal
    })
    const wire = await readWire(res)
    return buildSendReport(wire, { curl, unresolved: resolved.unresolved, sentAt, executorName: executor.name })
  } catch (e) {
    const err = e as { name?: string; message?: string }
    const message = err.message ?? String(e)
    const failure =
      err.name === 'AbortError'
        ? { kind: 'abort' as const, message: '已取消这次请求。', hint: '需要重跑就再点一次发送。' }
        : err.name === 'TimeoutError'
          ? { kind: 'timeout' as const, message: `超过 ${clientMs} ms 还没拿到 agent 结果，已断开。`, hint: '把「选项 → 总时限」放宽，或确认 agent 那台机器能连上目标。', raw: message }
          : {
              kind: 'unreachable' as const,
              message: `连不上执行机「${executor.name}」的 agent。`,
              hint: '检查 baseUrl 是否可达、反代/TLS 是否正常、agent 是否在跑。',
              raw: message
            }
    return {
      outcome: { ok: false, failure },
      unresolved: resolved.unresolved,
      blockedHeaders: [],
      notes: agentNotes(executor.name),
      curl,
      sentAt
    }
  } finally {
    for (const t of timers) clearTimeout(t)
    if (outer) outer.removeEventListener('abort', onAbort)
  }
}
