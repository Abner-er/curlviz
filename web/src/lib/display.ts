import { extractVars, type CurlSpec } from '@curlviz/core'
import type { HistoryEntry } from '../types'

/**
 * 界面里几处"算字符串"的小逻辑。
 * 单独成模块是为了脱离 jsdom 直接单测 —— 组件只负责把结果画出来，
 * 而这几个函数决定变量面板有没有漏、历史列表会不会泄密、下载文件名对不对。
 */

/**
 * 扫一遍 spec 里所有可能出现 {{变量}} 的位置。
 * rawArgs 也在内：逃生通道里的 {{host}} 同样得让用户看到"这个还没赋值"。
 */
export function usedVars(spec: CurlSpec): string[] {
  const texts = [
    spec.url,
    spec.headers.map((h) => `${h.key}\u0000${h.value}`).join('\n'),
    spec.query.map((h) => `${h.key}\u0000${h.value}`).join('\n'),
    spec.body.json,
    spec.body.raw,
    spec.body.form.map((f) => `${f.key}\u0000${f.value}`).join('\n'),
    spec.body.multipart
      .map((m) => `${m.key}\u0000${m.value}\u0000${m.filename ?? ''}\u0000${m.contentType ?? ''}`)
      .join('\n'),
    spec.auth.basic.username,
    spec.auth.basic.password,
    spec.auth.bearer.token,
    spec.options.userAgent,
    spec.options.proxy,
    ...spec.rawArgs
  ]
  const found = new Set<string>()
  for (const t of texts) for (const v of extractVars(t)) found.add(v)
  return [...found].sort()
}

/** Content-Type → 下载文件后缀；认不出来就 .bin，别硬套一个不相干的扩展名。 */
export function extOf(contentType: string): string {
  const ct = contentType.toLowerCase()
  if (ct.includes('json')) return '.json'
  if (ct.includes('html')) return '.html'
  if (ct.includes('xml')) return '.xml'
  if (ct.includes('plain')) return '.txt'
  if (ct.startsWith('image/png')) return '.png'
  if (ct.startsWith('image/jpeg')) return '.jpg'
  if (ct.startsWith('image/')) return '.img'
  if (ct === 'application/pdf') return '.pdf'
  return '.bin'
}

/** 下载名带发送时间戳，方便一次排查存多份；不塞随机数，免得 diff 不出谁先谁后。 */
export function suggestName(sentAt: number, contentType: string): string {
  const stamp = new Date(sentAt).toISOString().replace(/[:.]/g, '-').slice(0, 19)
  return `curlviz-${stamp}${extOf(contentType)}`
}

/** 历史列表那一行的结果摘要。ms 是总耗时，脱敏条目不带响应体，所以这里只有状态与耗时。 */
export function historySummary(entry: HistoryEntry): string {
  if (!entry.result) return '未发送'
  if ('error' in entry.result) return entry.result.error
  const ms = entry.result.ms
  const spent = ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${Math.round(ms)}ms`
  return `${entry.result.status} · ${spent}`
}

/**
 * 点「环境 · 变量」这类跳转按钮时，该不该用平滑滚动。
 *
 * 样式表里那条 prefers-reduced-motion 只管得住 CSS 动画与 transition，
 * 管不住 JS 的 scrollIntoView({behavior:'smooth'}) —— 勾了"减少动态效果"的人
 * 照样会被强制晃一下。这个决定只能在调用点上做，所以得是个能测的函数。
 */
export function scrollBehaviorFor(reduceMotion: boolean): 'auto' | 'smooth' {
  return reduceMotion ? 'auto' : 'smooth'
}

/**
 * 系统有没有勾"减少动态效果"。
 *
 * 只在浏览器的事件处理里调用，不进渲染：渲染里读 window 会让 SSR 冒烟测试直接炸。
 * 拿不到 matchMedia（老浏览器 / 测试环境）就当没勾 —— 猜错的最坏结果只是一下平滑滚动。
 */
export function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}
