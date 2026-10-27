import { extractVars, resolveSpec, type CurlSpec, type Param, type VarMap } from '@curlviz/core'
import { assessCors, corsPreSendNotice } from './fetch-rules'
import type { HistoryEntry } from '../types'

/**
 * 界面里几处"算字符串"的小逻辑。
 * 单独成模块是为了脱离 jsdom 直接单测 —— 组件只负责把结果画出来，
 * 而这几个函数决定变量面板有没有漏、历史列表会不会泄密、下载文件名对不对。
 */

/** 表格某一行的"特殊语义"胶囊：短文本 + 悬停解释。null = 不画。 */
export interface RowNote {
  text: string
  title: string
}

/**
 * 当前页面地址。取不到（SSR 冒烟测试 / node 测试环境）就返回空串，
 * 而空串会让跨域判定直接返回 null —— 判不出来时保持沉默，比猜一个 origin 更诚实。
 */
export function currentPageHref(): string {
  return globalThis.location?.href ?? ''
}

/**
 * 发送前就该看见的提醒。目前只有跨域预检一条，但判据留在 lib：组件只画结果。
 *
 * 先跑一遍 `resolveSpec` 是必需的 —— URL 里写着 `{{host}}/v1/chat` 时 origin 根本解析不出来，
 * 判成"没风险"，等于把最该提醒的那条命令漏掉。
 */
export function preSendNotices(spec: CurlSpec, vars: VarMap, pageHref: string): string[] {
  const notice = corsPreSendNotice(assessCors(resolveSpec(spec, vars).spec, pageHref))
  return notice === '' ? [] : [notice]
}

/**
 * query 表：`--url-query` 来的行要标出来。
 *
 * 不标就等于骗人：这一项复制出去时**不折进 URL**，仍写成 `--url-query 'k=v'`，
 * 编码由 curl 做；而折进 URL 的那一份是我们自己用 encodeURIComponent 编的。
 * 两者对同一个值能给出不同字节（空格 `+` vs `%20`），实测钉在 curl 8.19.0 上。
 */
export function queryRowNote(row: Param): RowNote | null {
  if (row.viaUrlQuery !== true) return null
  return {
    text: '--url-query',
    title:
      "这一项来自 --url-query：复制出去时仍写成 --url-query 'k=v'，不折进 URL。" +
      '编码交给 curl 自己做，而 curl 的表与我们折进 URL 的那份不同（空格 curl 编成 +，我们编成 %20）'
  }
}

/**
 * headers 表：值为空的行标成「删头」。
 *
 * 真实 curl 8.19.0 实测：`-H 'K:'` 是**不发这个头**，连 curl 自带的 Accept / User-Agent
 * 都删得掉；要发一行空值头得写 `-H 'K;'`（我们建模不了，原样留在「选项」页）。
 * 界面上只写着"值为空"，用户会以为发的是空值头 —— 这个误解足以让排查方向整体跑偏。
 */
export function headerRowNote(row: Param): RowNote | null {
  if (!row.enabled || row.key.trim() === '' || row.value !== '') return null
  return {
    text: '删头',
    title:
      "实测：curl 里 -H 'K:' 是不发这个头（连它自带的 Accept / User-Agent 都删得掉），不是发一个空值头。" +
      "要发空值行得写 -H 'K;'，那种形态我们建模不了，原样留在「选项」页"
  }
}

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
