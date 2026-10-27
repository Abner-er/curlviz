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

/** 发送前那次跨域判定的全部产出，一次算完给两处用。 */
export interface PreSendFacts {
  /** 折叠条里的完整提醒；没风险就是空数组。 */
  notices: string[]
  /** 这条到底会不会被浏览器打一次 OPTIONS 预检。只认预检，简单请求的读不到不算。 */
  preflightExpected: boolean
  /** 徽标悬停时念的那句（和 notices 里是同一条，不另写一份措辞）。 */
  reason: string
}

/**
 * 发送前就该看见的提醒 + 请求行那颗徽标，共用这一次判定。
 *
 * 为什么要合成一个函数：徽标和提醒要是各算各的，就会出现"徽标亮了、提醒却说没风险"
 * 这种自相矛盾，而用户只会记住被骗的那一次。
 * 先跑一遍 `resolveSpec` 是必需的 —— URL 里写着 `{{host}}/v1/chat` 时 origin 根本解析不出来，
 * 判成"没风险"，等于把最该提醒的那条命令漏掉。
 */
export function preSendFacts(spec: CurlSpec, vars: VarMap, pageHref: string): PreSendFacts {
  const risk = assessCors(resolveSpec(spec, vars).spec, pageHref)
  const notice = corsPreSendNotice(risk)
  return {
    notices: notice === '' ? [] : [notice],
    preflightExpected: risk !== null && risk.preflightReasons.length > 0,
    reason: notice
  }
}

/** 老调用点的形状：只要文案。 */
export function preSendNotices(spec: CurlSpec, vars: VarMap, pageHref: string): string[] {
  return preSendFacts(spec, vars, pageHref).notices
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
 * 操作栏上的计数徽章。0 一律不画。
 *
 * 一列按钮里挂着三个"0"，读起来像界面坏了；而"库里有多少条"这件事，
 * 空库本来就没有可点进去看的东西，0 与"没数字"对用户是同一个结果。
 * 例外留在调用点：环境那一格 0 个变量是 {{变量}} 没被替换的直接原因，那个 0 有信息量，得留。
 */
export function countBadge(n: number): string | undefined {
  return n > 0 ? `${n}` : undefined
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
