import { buildUrlWithQuery, type CurlSpec } from '@curlviz/core'

/**
 * 浏览器 fetch 与 curl 的第二条边界：**跨域时谁说了算的是服务器，不是这条命令**。
 *
 * 这条边界原先在界面里只有一句"分不清是被 CORS 拦了、服务不通、还是证书不受信"——
 * 那句没错，但太笼统：预检要不要发、由什么触发，是 Fetch 标准里**能算出来**的，
 * 不确定的只有"对方服务器答不答应"。所以把能算的部分做成纯函数，判据都摆在下面。
 */

/**
 * fetch 会静默丢弃的头（Fetch 标准的 forbidden header name 列表）。
 * 两处用到：http.ts 决定"这个头到底发不发"，本文件决定"这个头会不会触发预检"——
 * 被丢弃的头压根不会上线，也就不会触发预检，所以这张表必须共用一份。
 */
export const FORBIDDEN_REQUEST_HEADERS = new Set([
  'accept-charset',
  'accept-encoding',
  'access-control-request-headers',
  'access-control-request-method',
  'connection',
  'content-length',
  'cookie',
  'cookie2',
  'date',
  'dnt',
  'expect',
  'host',
  'keep-alive',
  'origin',
  'posture',
  'referer',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'proxy-connection'
])

/** 跨域"简单请求"的方法白名单：超出即触发预检。 */
const SAFELISTED_METHODS = new Set(['GET', 'HEAD', 'POST'])

/** 简单请求里允许出现的请求头（Content-Type 另外看值）。 */
const SAFELISTED_HEADERS = new Set(['accept', 'accept-language', 'content-language'])

/** Content-Type 只有这三个值是安全的；`application/json` 不在内——LLM 接口条条都踩。 */
const SAFELISTED_CONTENT_TYPES = new Set(['application/x-www-form-urlencoded', 'multipart/form-data', 'text/plain'])

export interface CorsRisk {
  crossOrigin: true
  pageOrigin: string
  targetOrigin: string
  /**
   * 触发 OPTIONS 预检的原因。空数组 = 这是"简单请求"，浏览器不会预检，
   * 直接发出去；但响应里没有 `Access-Control-Allow-Origin` 时照样读不到。
   */
  preflightReasons: string[]
}

/** 拿 origin（协议+主机+端口）。相对地址按 base 补全；解析不了就返回 null。 */
function originOf(raw: string, base: string): string | null {
  if (!raw) return null
  try {
    return new URL(raw, base || undefined).origin
  } catch {
    return null
  }
}

/**
 * 这条命令在这个页面上发送时，浏览器会怎么处理跨域。
 *
 * 返回 null 的三种情况：**同源**（没有跨域问题）、URL 还没填/解析不了、页面地址取不到。
 * 判据只用"能算出来的事实"，不猜服务器行为。
 */
export function assessCors(spec: CurlSpec, pageBase: string): CorsRisk | null {
  const pageOrigin = originOf(pageBase, pageBase)
  if (pageOrigin === null) return null

  const target = originOf(buildUrlWithQuery(spec.url, spec.query), pageBase)
  if (target === null || target === pageOrigin) return null

  const reasons: string[] = []

  // 方法：POST 带 body 是简单的，PUT/DELETE/PATCH/-X 自定义都得先过预检
  const method = spec.method.toUpperCase()
  if (!SAFELISTED_METHODS.has(method)) reasons.push(`方法 ${method} 不在 GET/HEAD/POST 之内`)

  /**
   * 只统计"真会上线"的头：禁用头被 fetch 悄悄丢掉，不上线也就不触发预检。
   * 与 http.ts 的 push() 保持同一套取舍，两边算出来的清单必须一致。
   */
  const names = new Set<string>()
  for (const h of spec.headers) {
    const key = h.key.trim().toLowerCase()
    if (!h.enabled || key === '' || FORBIDDEN_REQUEST_HEADERS.has(key)) continue
    names.add(key)
  }
  if (spec.auth.type === 'basic') names.add('authorization')
  if (spec.auth.type === 'bearer' && spec.auth.bearer.token.trim() !== '') names.add('authorization')
  if (spec.options.userAgent.trim() !== '') names.add('user-agent')

  for (const name of names) {
    if (name === 'content-type') continue // 单独按值判，见下
    if (SAFELISTED_HEADERS.has(name)) continue
    reasons.push(name === 'authorization' ? 'Authorization 头（带凭据，永远要预检）' : `头 ${name}`)
  }

  // Content-Type 看的是值：application/json 是最常见的那颗雷
  const ct = spec.headers.find((h) => h.enabled && h.key.trim().toLowerCase() === 'content-type')
  if (ct !== undefined) {
    const value = (ct.value.split(';')[0] ?? '').trim().toLowerCase()
    if (value !== '' && !SAFELISTED_CONTENT_TYPES.has(value)) reasons.push(`Content-Type: ${value}`)
  }

  return { crossOrigin: true, pageOrigin, targetOrigin: target, preflightReasons: [...new Set(reasons)] }
}

/** 发送前的一句话（curl 预览区）。空串 = 没什么要提醒的。 */
export function corsPreSendNotice(risk: CorsRisk | null): string {
  if (risk === null) return ''
  if (risk.preflightReasons.length > 0) {
    return (
      `到 ${risk.targetOrigin} 是跨域，而且这条会被浏览器先打一个 OPTIONS 预检` +
      `（触发点：${risk.preflightReasons.join('、')}）。预检要对方回 2xx 并带上 ` +
      'Access-Control-Allow-Methods / Allow-Headers 才放行——很多 API 网关压根没有 OPTIONS 路由，' +
      '那时浏览器报的是 CORS 错，而不是"命令写错了"。稳妥路径是「复制到终端」跑 curl。'
    )
  }
  return (
    `到 ${risk.targetOrigin} 是跨域。这条属于"简单请求"，浏览器不预检、直接发；` +
    '但对方响应里若没有 Access-Control-Allow-Origin，响应体照样读不到（fetch 当场抛）。' +
    '命令本身没问题，读不到是服务器的跨域策略——需要真发就「复制到终端」。'
  )
}

/**
 * fetch 抛错之后（blocked-or-network）的定向 hint。
 * 依旧不敢说"一定是 CORS"——服务不通、证书不受信在页面上同样看不出来；
 * 但能告诉用户"控制台那句话该对应到哪个原因"，比笼统一句"分不清"少走两趟弯路。
 */
export function corsFailureHint(risk: CorsRisk | null): string {
  const generic =
    '浏览器只报"fetch 失败"，分不清是被 CORS 拦了、服务不通、还是证书不受信。' +
    '先按 F12 看 Network 里这条是 CORS 报错还是连接错误；对方没有 CORS 头时请用「复制到终端」或本地 agent 发送。'
  if (risk === null) return generic
  if (risk.preflightReasons.length > 0) {
    return (
      `这条到 ${risk.targetOrigin} 要先过预检（触发点：${risk.preflightReasons.join('、')}）。` +
      '控制台若写着 "Response to preflight request doesn\'t pass access control check" 或 ' +
      '"It does not have HTTP ok status"，就是对方的 OPTIONS 没回 2xx —— 它的跨域支持只做到响应头那半截，' +
      '预检那半截没实现。浏览器这条路走不通，跟命令对不对无关：用「复制到终端」跑 curl，等本地 agent（M4）上线也能发。'
    )
  }
  return (
    `这条到 ${risk.targetOrigin} 属于简单请求，多半已经发出去了，` +
    '但对方没回 Access-Control-Allow-Origin 时响应体照样读不到——同样不是命令的问题。用「复制到终端」。'
  )
}
