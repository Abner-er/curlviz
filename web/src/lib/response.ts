import type { ResponseKind } from '../types'

/**
 * 预览上限 512KB（PLAN §6）。运维场景里"把 200MB 日志拖进浏览器渲染然后崩掉"是最常见的差评，
 * 宁可截断并如实写明，也别装得下。
 */
export const MAX_PREVIEW_BYTES = 512 * 1024

/** Content-Type 里的 charset；没有就 null。 */
export function charsetOf(contentType: string): string | null {
  const m = /charset\s*=\s*"?([\w-]+)"?/i.exec(contentType)
  return m?.[1] ? m[1].toLowerCase() : null
}

/**
 * 按 charset 解码。声明的编码浏览器不认（内网系统经常乱写）就退回 UTF-8，
 * TextDecoder 用非 fatal 模式，坏字节换成 U+FFFD 而不是抛错——运维要的是"看见内容"，不是严格性。
 */
export function decodeBody(bytes: Uint8Array, contentType: string): string {
  const wanted = charsetOf(contentType)
  for (const enc of wanted ? [wanted, 'utf-8'] : ['utf-8']) {
    try {
      return new TextDecoder(enc, { fatal: false }).decode(bytes)
    } catch {
      /* 换下一个候选编码 */
    }
  }
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes)
}

/**
 * 归类只看 Content-Type，只在它缺得离谱时兜底猜一次。
 * 二进制类（image/pdf）不参与文本解码预览，直接给下载。
 */
export function classifyBody(contentType: string, text: string, bytes: Uint8Array): ResponseKind {
  const ct = contentType.toLowerCase()
  if (ct.startsWith('image/')) return 'image'
  if (ct === 'application/pdf') return 'pdf'
  if (ct.includes('json')) return 'json'
  if (ct.includes('html')) return 'html'
  if (ct.includes('xml')) return 'xml'
  if (ct.startsWith('text/') || ct.includes('javascript') || ct.includes('csv')) return 'text'
  if (ct === '' || ct === 'application/octet-stream') return sniff(text, bytes)
  return 'binary'
}

/** 没告诉咱们是什么类型：有 NUL 就当二进制，像 JSON/HTML 就按那个渲染。 */
function sniff(text: string, bytes: Uint8Array): ResponseKind {
  const head = bytes.subarray(0, 512)
  for (const b of head) if (b === 0) return 'binary'
  const trimmed = text.trimStart()
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      JSON.parse(text)
      return 'json'
    } catch {
      /* 只是碰巧以花括号开头的文本 */
    }
  }
  if (/^<!doctype\s+html/i.test(trimmed) || /^<html[\s>]/i.test(trimmed)) return 'html'
  return 'text'
}

/** 截断到 max 字节；返回视图与是否超量。total 是服务端口径的总大小。 */
export function truncateBytes(
  bytes: Uint8Array,
  total: number | null,
  max = MAX_PREVIEW_BYTES
): { bytes: Uint8Array; truncated: boolean; totalBytes: number } {
  const totalBytes = total !== null && total > bytes.length ? total : bytes.length
  if (bytes.length <= max) return { bytes, truncated: false, totalBytes }
  return { bytes: bytes.subarray(0, max), truncated: true, totalBytes }
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  const units = ['KB', 'MB', 'GB']
  let v = n / 1024
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v.toFixed(v >= 100 ? 0 : 1)} ${units[i]}`
}

export function formatMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`
  return `${(ms / 1000).toFixed(2)} s`
}

/** JSON 美化；坏了就原样返回（内网接口偶发返回带 BOM / 注释的"JSON"）。 */
export function prettyJson(text: string): string {
  try {
    const stripped = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
    return JSON.stringify(JSON.parse(stripped), null, 2)
  } catch {
    return text
  }
}
