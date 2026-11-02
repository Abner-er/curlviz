import { CURLSPEC_VERSION, type CurlSpec } from '@curlviz/core'

/**
 * /exec 的线上契约（agent 侧）。字节形状逐字对齐 spec/README.md §13.1 与 §13.3：
 * web 的 agent-transport 与这里必须一一对上，将来 Kotlin 也照抄同一形状。
 *
 * 这层是纯的——只碰数据、不碰网络不碰进程，所以能用普通单测钉死，
 * 把"什么算一份合法请求 / 一份响应长什么样"和"怎么跑 curl"分开，各自好测。
 */

/** 请求体：只认 v:1，版本不符直接拒、不猜。spec 是 web 已替换过变量的完整 CurlSpec。 */
export interface ExecRequest {
  v: number
  spec: CurlSpec
}

/** agent 能回报的失败种类（对齐 web FailureKind 里 agent 相关那几档）。 */
export type WireFailureKind = 'agent-rejected' | 'agent-error' | 'timeout'

export interface WireFailure {
  kind: WireFailureKind
  message: string
  /** 可执行的下一步，不编造原因。 */
  hint?: string
  /** 原始错误文本，折叠在详情里方便排查。 */
  raw?: string
}

/** 成功响应：字段一一对应 web 的 SentResponse，响应视图因此一行不用改。 */
export interface WireAgentResponse {
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

/** 失败响应：HTTP 200 但带 failure，或非 2xx。 */
export type FailureResponse = { ok: false; failure: WireFailure }

export type WireResponse = { ok: true; response: WireAgentResponse } | FailureResponse

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 快速造一个失败体（HTTP 层与执行层都用它，措辞只在这一处定）。 */
export function failure(
  kind: WireFailureKind,
  message: string,
  hint?: string,
  raw?: string
): FailureResponse {
  const f: WireFailure = { kind, message }
  if (hint !== undefined) f.hint = hint
  if (raw !== undefined) f.raw = raw
  return { ok: false, failure: f }
}

/**
 * 校验并读出请求体。只做"能不能安全往下走"必需的最浅检查：
 * 版本、spec 形状、url 非空——够挡坏数据，也让 SSRF 层能拿到目标地址。
 * 逐字段的深校验交给 core 的 buildArgv（它对着同一 CurlSpec 类型），这里不重造。
 */
export function parseExecRequest(
  body: unknown
): { ok: true; request: ExecRequest } | { ok: false; response: FailureResponse } {
  if (!isRecord(body)) {
    return { ok: false, response: failure('agent-rejected', '请求体不是一个 JSON 对象。', '确认 Content-Type: application/json 且 body 是对象。') }
  }
  if (body.v !== CURLSPEC_VERSION) {
    return { ok: false, response: failure('agent-rejected', `只支持 v:${CURLSPEC_VERSION}，收到的是 v:${String(body.v)}。`, '升级 agent 或前端到匹配版本，两边不猜版本。') }
  }
  if (!isRecord(body.spec)) {
    return { ok: false, response: failure('agent-rejected', '缺少 spec 对象。', '发送前应带上完整的 CurlSpec。') }
  }
  const spec = body.spec as unknown as CurlSpec
  if (typeof spec.url !== 'string' || spec.url.trim() === '') {
    return { ok: false, response: failure('agent-rejected', 'spec.url 为空，没有可执行的目标。', '先填地址再发。') }
  }
  return { ok: true, request: { v: CURLSPEC_VERSION, spec } }
}
