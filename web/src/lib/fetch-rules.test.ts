import { describe, expect, it } from 'vitest'
import { createDefaultSpec, type CurlSpec, type Param } from '@curlviz/core'
import { assessCors, corsFailureHint, corsPreSendNotice } from './fetch-rules'

/**
 * 判据测试。这里钉的是"预检要不要发"——Fetch 标准里算得出的那半边。
 * 服务器答不答应算不出来，所以文案里也不许出现"一定是 CORS"这类话，见下面的措辞断言。
 */

const PAGE = 'http://localhost:5183/'

function spec(patch: Partial<CurlSpec> = {}): CurlSpec {
  return { ...createDefaultSpec('t'), url: 'http://localhost:5183/api', ...patch }
}

function param(key: string, value: string, enabled = true): Param {
  return { key, value, enabled }
}

/** 取 reasons 里合并成一句后的全文，省得每条都写 join()。 */
function reasonsOf(s: CurlSpec): string[] {
  const risk = assessCors(s, PAGE)
  if (risk === null) throw new Error('本该判成跨域，却返回了 null')
  return risk.preflightReasons
}

describe('assessCors：什么时候根本不用提跨域', () => {
  it('同源直接返回 null：跨域不是问题，就别拿跨域吓人', () => {
    expect(assessCors(spec(), PAGE)).toBeNull()
    // 端口与协议都相同，路径与 query 不同仍然同源
    expect(assessCors(spec({ url: 'http://localhost:5183/v2/chat?x=1' }), PAGE)).toBeNull()
  })

  it('URL 没填、或页面地址取不到：判不出来就保持沉默', () => {
    expect(assessCors(spec({ url: '' }), PAGE)).toBeNull()
    // 实测 'http://' 会让 new URL 抛错（'not a url' 那种反而解析得开——它会按相对地址落到同源，
    // 所以想测"解析失败"这条分支必须用真抛错的串）
    expect(assessCors(spec({ url: 'http://' }), PAGE)).toBeNull()
    expect(assessCors(spec({ url: 'https://api.example.com/x' }), '')).toBeNull()
  })

  it('协议不同、端口不同都算跨域，并报出目标 origin', () => {
    const up = assessCors(spec({ url: 'https://localhost:5183/api' }), PAGE)
    expect(up?.targetOrigin).toBe('https://localhost:5183')
    const port = assessCors(spec({ url: 'http://127.0.0.1:8080/api' }), PAGE)
    expect(port?.targetOrigin).toBe('http://127.0.0.1:8080')
    expect(port?.pageOrigin).toBe('http://localhost:5183')
  })
})

describe('assessCors：预检触发点', () => {
  it('跨域的普通 GET 是"简单请求"：不预检，但仍然算跨域', () => {
    const risk = assessCors(spec({ url: 'https://api.example.com/ping' }), PAGE)
    expect(risk?.preflightReasons).toEqual([])
    expect(corsPreSendNotice(risk)).toContain('简单请求')
  })

  it('方法超出 GET/HEAD/POST 就要预检', () => {
    expect(reasonsOf(spec({ url: 'https://api.example.com/p', method: 'PUT' }))).toContain('方法 PUT 不在 GET/HEAD/POST 之内')
    expect(reasonsOf(spec({ url: 'https://api.example.com/p', method: 'delete' }))).toContain(
      '方法 DELETE 不在 GET/HEAD/POST 之内'
    )
    // POST 带 body 属于简单请求，别把 -X POST 的正常用法误报成要预检
    const post = spec({
      url: 'https://api.example.com/p',
      method: 'POST',
      body: { ...createDefaultSpec('b').body, type: 'form', form: [param('k', 'v')] }
    })
    expect(reasonsOf(post)).toEqual([])
  })

  it('application/json 是最常见的那颗雷；charset 参数不参与判断', () => {
    const s = spec({ url: 'https://api.example.com/p', method: 'POST' })
    expect(reasonsOf({ ...s, headers: [param('Content-Type', 'application/json')] })).toContain('Content-Type: application/json')
    expect(
      reasonsOf({ ...s, headers: [param('content-type', 'Application/JSON; charset=utf-8')] })
    ).toContain('Content-Type: application/json')
  })

  it('三个安全的 Content-Type 不触发预检', () => {
    const s = spec({ url: 'https://api.example.com/p', method: 'POST' })
    for (const ct of ['application/x-www-form-urlencoded', 'multipart/form-data', 'text/plain']) {
      expect(reasonsOf({ ...s, headers: [param('Content-Type', ct)] })).toEqual([])
    }
  })

  it('带凭据就点名"永远要预检"，basic 与 bearer 都算', () => {
    const basic = spec({
      url: 'https://api.example.com/p',
      auth: { type: 'basic', basic: { username: 'u', password: 'p' }, bearer: { token: '' } }
    })
    expect(reasonsOf(basic).some((r) => r.startsWith('Authorization'))).toBe(true)
    const bearer = spec({
      url: 'https://api.example.com/p',
      auth: { type: 'bearer', basic: { username: '', password: '' }, bearer: { token: 'tk' } }
    })
    expect(reasonsOf(bearer)).toEqual(['Authorization 头（带凭据，永远要预检）'])
    // 空 token 等于没发这个头，不该算触发点
    const empty = spec({
      url: 'https://api.example.com/p',
      auth: { type: 'bearer', basic: { username: '', password: '' }, bearer: { token: '   ' } }
    })
    expect(reasonsOf(empty)).toEqual([])
  })

  it('自定义头触发；Accept / Accept-Language / Content-Language 在安全清单里，不触发', () => {
    expect(reasonsOf(spec({ url: 'https://api.example.com/p', headers: [param('X-Token', 'a')] }))).toContain('头 x-token')
    expect(
      reasonsOf(
        spec({
          url: 'https://api.example.com/p',
          headers: [param('Accept', 'application/json'), param('Accept-Language', 'zh'), param('Content-Language', 'zh')]
        })
      )
    ).toEqual([])
  })

  it('-A 会真的多一次预检：它不在安全清单里，也不在 forbidden 列表里', () => {
    const s = spec({ url: 'https://api.example.com/p', options: { ...createDefaultSpec('o').options, userAgent: 'ops-cli/1.0' } })
    expect(reasonsOf(s)).toContain('头 user-agent')
  })

  it('勾选关掉(enabled=false)的头不上线，也就不触发预检', () => {
    const s = spec({ url: 'https://api.example.com/p', headers: [param('X-Token', 'a', false)] })
    expect(reasonsOf(s)).toEqual([])
  })

  it('Cookie / Host 这类 forbidden 头会被 fetch 丢掉：不上线就不触发预检', () => {
    // 判据必须与 http.ts 的取舍一致 —— 那边丢掉、这边当"不触发"，两处只能有一张表
    const s = spec({
      url: 'https://api.example.com/p',
      headers: [param('Cookie', 'a=1'), param('Host', 'api.example.com'), param('Referer', 'http://x/')]
    })
    expect(reasonsOf(s)).toEqual([])
  })

  it('同一个触发点只列一次（Authorization 既来自 -H 又来自认证页时）', () => {
    const s = spec({
      url: 'https://api.example.com/p',
      headers: [param('Authorization', 'Basic xx')],
      auth: { type: 'basic', basic: { username: 'u', password: 'p' }, bearer: { token: '' } }
    })
    expect(reasonsOf(s).filter((r) => r.startsWith('Authorization'))).toHaveLength(1)
  })
})

describe('两段文案各自的边界', () => {
  it('判不出来时 hint 仍留那句"分不清"，不硬编成 CORS', () => {
    const hint = corsFailureHint(null)
    expect(hint).toContain('分不清')
    expect(hint).toContain('Network')
    expect(corsPreSendNotice(null)).toBe('')
  })

  it('预检型 hint 直接引用浏览器原话，并给出「复制到终端」这条出路', () => {
    const risk = assessCors(
      spec({ url: 'https://token.sensenova.cn/v1/chat/completions', method: 'POST', headers: [param('Content-Type', 'application/json')] }),
      PAGE
    )
    const pre = corsPreSendNotice(risk)
    expect(pre).toContain('OPTIONS 预检')
    expect(pre).toContain('Content-Type: application/json')
    expect(pre).toContain('复制到终端')
    const after = corsFailureHint(risk)
    expect(after).toContain("doesn't pass access control check")
    expect(after).toContain('HTTP ok status')
    // 只说"对方的 OPTIONS 没回 2xx 会怎样"，不说"这次一定就是 CORS"
    expect(after).not.toContain('一定是 CORS')
  })

  it('简单请求型文案讲清"发得出去但读不到"', () => {
    const risk = assessCors(spec({ url: 'https://api.example.com/ping' }), PAGE)
    expect(corsPreSendNotice(risk)).toContain('Access-Control-Allow-Origin')
    expect(corsFailureHint(risk)).toContain('读不到')
  })
})
