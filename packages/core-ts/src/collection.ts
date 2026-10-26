/**
 * 集合文件（导入导出）+ spec 归一化 + 敏感信息脱敏。
 *
 * 归一化是防御性设计：导入的 JSON 来自外部，字段可能缺、类型可能错。
 * 不归一就直接用的话，UI 会在 `spec.headers.map` 这类地方崩，而且崩在用户双击
 * 文件那一刻，最难排查。所以所有外部入口（导入、历史反序列化、安卓传来的 JSON）
 * 一律先过 normalizeSpec。
 */

import { splitOutsideQuotes } from './parse'
import {
  COLLECTION_FORMAT,
  CURLSPEC_VERSION,
  createDefaultSpec,
  type AuthConfig,
  type BodyType,
  type Collection,
  type CurlSpec,
  type Environment,
  type MultipartParam,
  type Param,
  type RequestBody
} from './types'

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

function asBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

function asNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function normalizeParam(value: unknown): Param | null {
  const o = asRecord(value)
  const key = o['key']
  if (typeof key !== 'string' || key === '') return null
  return {
    key,
    value: asString(o['value'], ''),
    enabled: asBoolean(o['enabled'], true)
  }
}

function normalizeParams(value: unknown): Param[] {
  if (!Array.isArray(value)) return []
  return value.map(normalizeParam).filter((p): p is Param => p !== null)
}

function normalizeMultipart(value: unknown): MultipartParam | null {
  const o = asRecord(value)
  const key = o['key']
  if (typeof key !== 'string' || key === '') return null
  const kind = o['kind'] === 'file' ? 'file' : 'text'
  const out: MultipartParam = {
    key,
    kind,
    value: asString(o['value'], ''),
    enabled: asBoolean(o['enabled'], true)
  }
  const filename = o['filename']
  if (typeof filename === 'string' && filename !== '') out.filename = filename
  const contentType = o['contentType']
  if (typeof contentType === 'string' && contentType !== '') out.contentType = contentType
  return out
}

const BODY_TYPES = new Set<BodyType>(['none', 'json', 'form', 'multipart', 'raw'])

function normalizeBody(value: unknown): RequestBody {
  const o = asRecord(value)
  const rawType = asString(o['type'], 'none')
  const type: BodyType = BODY_TYPES.has(rawType as BodyType) ? (rawType as BodyType) : 'none'
  return {
    type,
    json: asString(o['json'], ''),
    form: normalizeParams(o['form']),
    multipart: Array.isArray(o['multipart'])
      ? o['multipart'].map(normalizeMultipart).filter((m): m is MultipartParam => m !== null)
      : [],
    raw: asString(o['raw'], '')
  }
}

function normalizeAuth(value: unknown): AuthConfig {
  const o = asRecord(value)
  const rawType = asString(o['type'], 'none')
  const type = rawType === 'basic' || rawType === 'bearer' ? rawType : 'none'
  const basic = asRecord(o['basic'])
  const bearer = asRecord(o['bearer'])
  return {
    type,
    basic: { username: asString(basic['username'], ''), password: asString(basic['password'], '') },
    bearer: { token: asString(bearer['token'], '') }
  }
}

function normalizeOptions(value: unknown): CurlSpec['options'] {
  const def = createDefaultSpec().options
  const o = asRecord(value)
  // 老数据可能没有 connectTimeoutMs，缺失时按"未设置"而不是默认值处理
  return {
    followRedirects: asBoolean(o['followRedirects'], def.followRedirects),
    insecure: asBoolean(o['insecure'], def.insecure),
    compressed: asBoolean(o['compressed'], def.compressed),
    timeoutMs: asNumber(o['timeoutMs'], def.timeoutMs),
    connectTimeoutMs: asNumber(o['connectTimeoutMs'], 0),
    userAgent: asString(o['userAgent'], ''),
    proxy: asString(o['proxy'], '')
  }
}

/** 任意来源的对象 → 结构完整的 CurlSpec。 */
export function normalizeSpec(value: unknown): CurlSpec {
  const o = asRecord(value)
  const base = createDefaultSpec(asString(o['name'], ''))
  const rawArgs = Array.isArray(o['rawArgs'])
    ? o['rawArgs'].filter((a): a is string => typeof a === 'string')
    : []
  return {
    version: asNumber(o['version'], CURLSPEC_VERSION),
    name: asString(o['name'], ''),
    method: asString(o['method'], 'GET').toUpperCase() || 'GET',
    url: asString(o['url'], ''),
    query: normalizeParams(o['query']),
    headers: normalizeParams(o['headers']),
    body: normalizeBody(o['body']),
    auth: normalizeAuth(o['auth']),
    options: normalizeOptions(o['options']),
    rawArgs
  }
}

function normalizeEnvironment(value: unknown): Environment {
  const o = asRecord(value)
  return { name: asString(o['name'], '默认环境'), variables: normalizeParams(o['variables']) }
}

/** 解析集合 JSON；格式不对时抛错并说明原因。 */
export function parseCollection(text: string): Collection {
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch (err) {
    throw new Error(`不是合法 JSON：${err instanceof Error ? err.message : String(err)}`)
  }
  const o = asRecord(data)
  const format = asString(o['format'], '')
  if (format !== COLLECTION_FORMAT) {
    throw new Error(
      `format 字段应为 "${COLLECTION_FORMAT}"，实际是 ${format === '' ? '(缺失)' : `"${format}"`}——` +
        `可能来自其它工具，请在 CurlViz 里先导入再导出`
    )
  }
  return {
    format: COLLECTION_FORMAT,
    version: asNumber(o['version'], 1),
    environments: Array.isArray(o['environments']) ? o['environments'].map(normalizeEnvironment) : [],
    requests: Array.isArray(o['requests']) ? o['requests'].map(normalizeSpec) : []
  }
}

export function buildCollection(requests: CurlSpec[], environments: Environment[] = []): Collection {
  return { format: COLLECTION_FORMAT, version: 1, environments, requests }
}

export function serializeCollection(collection: Collection, pretty = true): string {
  return pretty ? JSON.stringify(collection, null, 2) : JSON.stringify(collection)
}

/* ------------------------------------------------------------------ */
/* 脱敏                                                                */
/* ------------------------------------------------------------------ */

const SECRET_HEADER = /^(authorization|proxy-authorization|cookie|x-api-key|api-key|apikey|x-auth-token)$/i

/**
 * 遮盖凭据：整串换成固定点位，一个原文字符都不留。
 * 以前保留过首尾各 3 位（看着好认是哪个 token），但 M2 起脱敏结果会**离开这台机器**
 * （导出文件、分享链接、二维码），首尾片段足够拿去撞库或补全，留着就是泄露。
 * 识别"这是哪条凭据"由头名负责，不该由值负责。
 */
function mask(): string {
  return FULL_MASK
}

const SECRET_QUERY = /(token|secret|password|passwd|key|signature|sig|auth)/i

/** 整串替换，不保留任何原文片段——保留尾部曾把 Bearer 长令牌漏出去过。 */
const FULL_MASK = '••••••••'

/** rawArgs 里"值即凭据"的 flag（归一化成长名后比对）。 */
const SECRET_RAW_FLAGS = new Set(['user', 'proxy-user', 'cookie', 'oauth2-bearer'])

const SHORT_FOR_REDACT: Record<string, string> = { u: 'user', U: 'proxy-user', H: 'header', b: 'cookie' }

/** `-H` / `--header` 的值形如 `'Name: value'`，取头名用。 */
function headerNameOf(inner: string): string {
  const colon = inner.indexOf(':')
  return (colon === -1 ? inner : inner.slice(0, colon)).trim()
}

function stripQuotes(text: string): string {
  const first = text[0]
  const last = text[text.length - 1]
  return text.length >= 2 && (first === "'" || first === '"') && last === first ? text.slice(1, -1) : text
}

function flagLongName(head: string): string {
  if (head.startsWith('--')) return head.slice(2)
  if (head.startsWith('-') && head.length === 2) return SHORT_FOR_REDACT[head.slice(1)] ?? head.slice(1)
  return head
}

/**
 * 遮盖一条 rawArg。
 * rawArg 形如 `--retry 3` / `-H 'Authorization: Bearer x'` / `-u bob:pw` / `-s`，
 * 按空白切会切坏带引号的值，所以走引号感知拆分（与解析方向共用同一套切分，不另起炉灶）。
 */
function redactRawArg(arg: string): string {
  const tokens = splitOutsideQuotes(arg, ' ').filter((t) => t !== '')
  if (tokens.length === 0) return arg
  const head = tokens[0] as string
  const long = flagLongName(head)
  const valueTokens = tokens.slice(1)
  if (valueTokens.length === 0) return arg
  const value = valueTokens[0] as string

  if (long === 'header') {
    const inner = stripQuotes(value)
    const name = headerNameOf(inner)
    if (!SECRET_HEADER.test(name)) return arg
    return `${head} '${name}: ${FULL_MASK}'`
  }
  if (SECRET_QUERY.test(long) || SECRET_RAW_FLAGS.has(long)) {
    return `${head} ${FULL_MASK}`
  }
  return arg
}

/**
 * 生成可安全展示 / 分享 / 落历史的副本。
 * 默认遮盖 Authorization、Cookie 等认证头，以及 basic / bearer 认证字段。
 * 注意：URL 里的 token 类 query 参数也一并遮盖（`?access_token=` 这类是常见泄露点）。
 */
export function redactSpec(spec: CurlSpec): CurlSpec {
  const out: CurlSpec = JSON.parse(JSON.stringify(spec)) as CurlSpec
  out.headers = out.headers.map((h) =>
    SECRET_HEADER.test(h.key) ? { ...h, value: mask() } : h
  )
  if (out.auth.type === 'basic') {
    out.auth.basic = { username: out.auth.basic.username, password: mask() }
  }
  if (out.auth.type === 'bearer') {
    out.auth.bearer = { token: mask() }
  }
  out.query = out.query.map((q) => (SECRET_QUERY.test(q.key) ? { ...q, value: mask() } : q))
  out.rawArgs = out.rawArgs.map(redactRawArg)
  return out
}

/** 判断 spec 是否含敏感字段，供 UI 打"已脱敏"标记。 */
export function hasSensitive(spec: CurlSpec): boolean {
  if (spec.auth.type !== 'none') return true
  if (spec.headers.some((h) => SECRET_HEADER.test(h.key))) return true
  return false
}
