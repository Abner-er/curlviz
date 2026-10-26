import { normalizeSpec, type Collection, type CurlSpec } from '@curlviz/core'

/**
 * 分享载荷：把「一个请求」或「整个集合」压成一段可放进链接 / 二维码的文本。
 *
 * 三条设计约束，都是从这个项目的立身之本推出来的：
 *  1. **不过云**。压缩用浏览器原生的 CompressionStream(gzip)，编码用 base64url，
 *     全程本地计算；绝不接任何"短链 / 二维码 API"，那等于把内网接口地址交给第三方。
 *  2. **自描述、可演进**。前缀带格式版本（curlviz:1:）与压缩标记（g=gzip，p=明文），
 *     将来 M3 安卓端照这一节实现即可互通，读不懂时明确报错而不是瞎猜。
 *  3. **默认脱敏**。脱敏由调用方决定并记录在 payload.redacted 里，界面上必须显示出来，
 *     免得用户以为分享出去的链接里没有密码。
 *
 * 格式契约已写进 spec/README，改这里的任何一个字符都要同步文档。
 */

export const SHARE_PREFIX = 'curlviz:1:'
export const SHARE_HASH_KEY = 'share'

/**
 * 二维码容量经验值。QR 版本 40 的 byte 模式理论上限约 2953 字节，
 * 但真拿手机扫这么密的码，对焦差一点就读不出来 —— 运维是在机房门口扫码，不是在做实验。
 * 所以 1024 字节以内算"好扫"，超过就提示改用链接。
 */
export const QR_COMFORT_BYTES = 1024
export const QR_MAX_BYTES = 2600

export type ShareKind = 'request' | 'collection'

export interface SharePayload {
  kind: ShareKind
  /** kind=request 时必填。 */
  spec?: CurlSpec
  /** kind=collection 时必填。 */
  collection?: Collection
  /** 载荷里的凭据是否已被抹掉。 */
  redacted: boolean
  /** 生成时间，仅用于展示与排查。 */
  at: number
}

/** 解码失败的原因，全部如实转成给用户看的一句话。 */
export class ShareError extends Error {
  readonly hint: string
  constructor(message: string, hint: string) {
    super(message)
    this.name = 'ShareError'
    this.hint = hint
  }
}

/* ------------------------------------------------------------------ */
/* base64url（二进制安全，不依赖 btoa 的 latin1 之外的能力）            */
/* ------------------------------------------------------------------ */

export function bytesToBase64Url(bytes: Uint8Array): string {
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function base64UrlToBytes(text: string): Uint8Array {
  const b64 = text.replace(/-/g, '+').replace(/_/g, '/')
  const pad = b64.length % 4 === 0 ? '' : '='.repeat(4 - (b64.length % 4))
  const bin = atob(b64 + pad)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

/* ------------------------------------------------------------------ */
/* gzip：浏览器 / Node 都有的原生 CompressionStream，不引第三方        */
/* ------------------------------------------------------------------ */

const encoder = new TextEncoder()
const decoder = new TextDecoder()

async function compress(bytes: Uint8Array): Promise<Uint8Array> {
  if (typeof CompressionStream === 'undefined') {
    throw new ShareError('当前环境没有 gzip 能力', '本工具的二维码依赖浏览器的 CompressionStream，请用 http/https 打开页面。')
  }
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new CompressionStream('gzip'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

async function decompress(bytes: Uint8Array): Promise<Uint8Array> {
  if (typeof DecompressionStream === 'undefined') {
    throw new ShareError('当前环境没有 gzip 解压能力', '请用 http/https 打开页面后再导入分享链接。')
  }
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream('gzip'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

/* ------------------------------------------------------------------ */
/* 编解码                                                              */
/* ------------------------------------------------------------------ */

/** 编码成 `curlviz:1:g<base64url>`；明文标记为 `p`。 */
export async function encodeShare(payload: SharePayload, preferGzip = true): Promise<string> {
  const json = JSON.stringify(payload)
  const bytes = encoder.encode(json)
  if (preferGzip) {
    try {
      const gz = await compress(bytes)
      // 压完反而更大（极小载荷会有这情况）就走明文，别为了好看多一层解压
      if (gz.length < bytes.length) return `${SHARE_PREFIX}g${bytesToBase64Url(gz)}`
    } catch {
      // 压缩能力缺失或失败：退回明文，功能不塌，只是分享码长一点
    }
  }
  return `${SHARE_PREFIX}p${bytesToBase64Url(bytes)}`
}

export async function decodeShare(text: string): Promise<SharePayload> {
  const trimmed = text.trim().replace(/^https?:\/\/[^#]*#/, '').replace(/^[?&]/, '')
  const fromHash = trimmed.includes(`${SHARE_HASH_KEY}=`)
    ? decodeURIComponent(trimmed.slice(trimmed.indexOf(`${SHARE_HASH_KEY}=`) + SHARE_HASH_KEY.length + 1))
    : trimmed
  if (!fromHash.startsWith(SHARE_PREFIX)) {
    throw new ShareError('这段内容不是 CurlViz 的分享码', '前缀应当是 curlviz:1:；也可能是别的工具生成的，请复制完整的那一串。')
  }
  const body = fromHash.slice(SHARE_PREFIX.length)
  const mark = body[0]
  const data = body.slice(1)
  if (mark !== 'g' && mark !== 'p') {
    throw new ShareError(`不认识的压缩标记「${mark ?? '空'}」`, '可能是更新版本生成的，换个新页面再试。')
  }
  let bytes: Uint8Array
  try {
    bytes = base64UrlToBytes(data)
  } catch {
    throw new ShareError('分享码在传输中被截断了', '多半是复制链接/码时少了尾巴，重新分享一份。')
  }
  let jsonBytes: Uint8Array
  try {
    jsonBytes = mark === 'g' ? await decompress(bytes) : bytes
  } catch (e) {
    if (e instanceof ShareError) throw e
    throw new ShareError('分享码解不开（gzip 数据坏了）', '多半是复制时少了尾巴，或被聊天软件折断了行；重新分享一份。')
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(decoder.decode(jsonBytes))
  } catch {
    throw new ShareError('分享码内容解不开（不是合法 JSON）', '这份数据可能已经坏了，重新分享一份。')
  }
  return validatePayload(parsed)
}

/** 解开的东西得先确认长得像样，再把控制权交给界面。 */
function validatePayload(value: unknown): SharePayload {
  if (typeof value !== 'object' || value === null) {
    throw new ShareError('分享码内容不是对象', '这份数据已经坏了，重新分享一份。')
  }
  const o = value as Record<string, unknown>
  if (o.kind !== 'request' && o.kind !== 'collection') {
    throw new ShareError('分享码缺少 kind 字段', '可能是旧版本或其他工具生成的，无法导入。')
  }
  const redacted = o.redacted === true
  if (o.kind === 'request') {
    if (typeof o.spec !== 'object' || o.spec === null) {
      throw new ShareError('分享码说自己是请求，却没带 spec', '数据坏了，重新分享一份。')
    }
    return { kind: 'request', spec: normalizeSpec(o.spec), redacted, at: typeof o.at === 'number' ? o.at : Date.now() }
  }
  const col = o.collection as Record<string, unknown> | undefined
  if (!col || !Array.isArray(col.requests)) {
    throw new ShareError('分享码说自己是集合，却没带 requests', '数据坏了，重新分享一份。')
  }
  return {
    kind: 'collection',
    collection: {
      format: 'curlviz-collection',
      version: typeof col.version === 'number' ? col.version : 1,
      environments: Array.isArray(col.environments) ? (col.environments as Collection['environments']) : [],
      requests: col.requests.map((r) => normalizeSpec(r))
    },
    redacted,
    at: typeof o.at === 'number' ? o.at : Date.now()
  }
}

/** 拼成可点开的链接：走 hash，不进服务端访问日志，也不会被 referer 带出去。 */
export function buildShareUrl(shareText: string, base = globalThis.location?.href ?? ''): string {
  const clean = base.split('#')[0]
  return `${clean}#${SHARE_HASH_KEY}=${encodeURIComponent(shareText)}`
}

export function shareSizeHint(shareText: string): { bytes: number; message: string | null } {
  const bytes = encoder.encode(shareText).length
  if (bytes > QR_MAX_BYTES) {
    return {
      bytes,
      message: `${bytes} 字节，超过二维码能装的上限（约 ${QR_MAX_BYTES}），这份只能走链接或导出文件。`
    }
  }
  if (bytes > QR_COMFORT_BYTES) {
    return {
      bytes,
      message: `${bytes} 字节，码会很密；手机扫不动就用链接，或拆成单个请求再分享。`
    }
  }
  return { bytes, message: null }
}

export function createPayload(kind: 'request', spec: CurlSpec, redacted: boolean): SharePayload
export function createPayload(kind: 'collection', collection: Collection, redacted: boolean): SharePayload
export function createPayload(
  kind: ShareKind,
  content: CurlSpec | Collection,
  redacted: boolean
): SharePayload {
  const base: SharePayload = { kind, redacted, at: Date.now() }
  return kind === 'request'
    ? { ...base, spec: content as CurlSpec }
    : { ...base, collection: content as Collection }
}
