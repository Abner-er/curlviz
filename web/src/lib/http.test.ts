import { afterEach, describe, expect, it, vi } from 'vitest'
import { createDefaultSpec, generateCurl, type CurlSpec, type MultipartParam, type Param } from '@curlviz/core'
import { MAX_PREVIEW_BYTES } from './response'
import { buildRequest, sendSpec } from './http'

function spec(base: CurlSpec = createDefaultSpec('t')): CurlSpec {
  return base
}

function param(key: string, value: string, enabled = true): Param {
  return { key, value, enabled }
}

function mp(key: string, kind: MultipartParam['kind'], value: string, enabled = true): MultipartParam {
  return { key, kind, value, enabled }
}

/** 头名大小写不敏感地取值。 */
function headerOf(init: RequestInit, name: string): string | undefined {
  return new Headers(init.headers).get(name) ?? undefined
}

function headerNames(init: RequestInit): string[] {
  const out: string[] = []
  new Headers(init.headers).forEach((_v, k) => out.push(k))
  return out
}

describe('buildRequest', () => {
  it('GET 不带 body；JSON 体自动补 Content-Type', () => {
    const s = spec()
    s.url = 'https://api.example.com/ping'
    expect(buildRequest(s).init.method).toBe('GET')
    expect(buildRequest(s).init.body).toBeNull()

    s.method = 'POST'
    s.body = { ...s.body, type: 'json', json: '{"a":1}' }
    const r = buildRequest(s)
    expect(r.init.method).toBe('POST')
    expect(r.init.body).toBe('{"a":1}')
    expect(headerOf(r.init, 'content-type')).toBe('application/json')
    expect(r.hasBody).toBe(true)
  })

  it('Basic 走 Authorization 头（正确 base64），Bearer 原样带 token', () => {
    const s = spec()
    s.url = 'https://api.example.com/ping'
    s.auth = { type: 'basic', basic: { username: 'user', password: 'pass' }, bearer: { token: '' } }
    expect(headerOf(buildRequest(s).init, 'authorization')).toBe('Basic dXNlcjpwYXNz')

    s.auth = { type: 'bearer', basic: { username: '', password: '' }, bearer: { token: 'tok' } }
    expect(headerOf(buildRequest(s).init, 'authorization')).toBe('Bearer tok')

    // 空 token 等于没设，别发出 "Bearer " 这种半截头
    s.auth = { type: 'bearer', basic: { username: '', password: '' }, bearer: { token: '  ' } }
    expect(headerOf(buildRequest(s).init, 'authorization')).toBeUndefined()
  })

  it('同名头只发第一个，禁用行与空键名跳过', () => {
    const s = spec()
    s.url = 'https://api.example.com/ping'
    s.headers = [
      param('Accept', 'application/json'),
      param('accept', 'text/html'),
      param('X-Trace', '1'),
      param('X-Skip', 'nope', false),
      param('   ', '幽灵值')
    ]
    const r = buildRequest(s)
    expect(headerOf(r.init, 'accept')).toBe('application/json')
    expect(headerNames(r.init).filter((n) => n === 'x-trace')).toHaveLength(1)
    expect(headerNames(r.init)).not.toContain('x-skip')
    expect(headerNames(r.init)).not.toContain('   ')
  })

  it('浏览器禁止的头如实标出来，而不是假装发出去了', () => {
    const s = spec()
    s.url = 'https://api.example.com/ping'
    s.headers = [param('Cookie', 'a=1'), param('Host', 'internal'), param('Content-Length', '10'), param('X-Ok', '1')]
    const r = buildRequest(s)
    expect(r.blockedHeaders.sort()).toEqual(['Content-Length', 'Cookie', 'Host'])
    expect(headerNames(r.init)).toEqual(['x-ok'])
  })

  it('用户自己写的 Content-Type 优先，自动补的那条不会覆盖它', () => {
    const s = spec()
    s.url = 'https://api.example.com/ping'
    s.method = 'POST'
    s.headers = [param('Content-Type', 'application/vnd.custom+json')]
    s.body = { ...s.body, type: 'json', json: '{}' }
    expect(headerOf(buildRequest(s).init, 'content-type')).toBe('application/vnd.custom+json')
  })

  it('raw 体不猜 Content-Type（curl --data-binary 也是这个行为）', () => {
    const s = spec()
    s.url = 'https://api.example.com/ping'
    s.method = 'POST'
    s.body = { ...s.body, type: 'raw', raw: '<xml/>' }
    const r = buildRequest(s)
    expect(r.init.body).toBe('<xml/>')
    expect(headerOf(r.init, 'content-type')).toBeUndefined()
  })

  it('form 体做 URL 编码并声明 x-www-form-urlencoded', () => {
    const s = spec()
    s.url = 'https://api.example.com/ping'
    s.method = 'POST'
    s.body = { ...s.body, type: 'form', form: [param('q', 'a b&c'), param('n', '1')] }
    const r = buildRequest(s)
    expect(r.init.body).toBe('q=a%20b%26c&n=1')
    expect(headerOf(r.init, 'content-type')).toBe('application/x-www-form-urlencoded')
  })

  it('multipart 交 FormData 并绝不自己设 Content-Type（boundary 会被写死而坏请求）', () => {
    const s = spec()
    s.url = 'https://api.example.com/ping'
    s.method = 'POST'
    s.body = { ...s.body, type: 'multipart', multipart: [mp('name', 'text', '栖云'), mp('note', 'text', 'hi')] }
    const r = buildRequest(s)
    expect(headerOf(r.init, 'content-type')).toBeUndefined()
    expect(r.init.body).toBeInstanceOf(FormData)
    expect((r.init.body as FormData).get('name')).toBe('栖云')
    expect(r.filePartBlocked).toBe(false)
  })

  it('multipart 的文件字段浏览器读不到：跳过文件、保留文本、并写明原因', () => {
    const s = spec()
    s.url = 'https://api.example.com/ping'
    s.method = 'POST'
    s.body = { ...s.body, type: 'multipart', multipart: [mp('file', 'file', 'D:/logs/a.txt'), mp('name', 'text', 'x')] }
    const r = buildRequest(s)
    expect(r.filePartBlocked).toBe(true)
    expect([...(r.init.body as FormData).keys()]).toEqual(['name'])
    expect(r.notes.join()).toContain('本地文件')
  })

  it('-A 能设但提醒会多一次预检；-L 关掉就是 manual', () => {
    const s = spec()
    s.url = 'https://api.example.com/ping'
    s.options = { ...s.options, followRedirects: false, userAgent: 'ops-cli/1.0' }
    const r = buildRequest(s)
    expect(headerOf(r.init, 'user-agent')).toBe('ops-cli/1.0')
    expect(r.init.redirect).toBe('manual')
    expect(r.notes.join()).toContain('预检')
  })

  it('浏览器做不到的选项逐条说明，不静默忽略', () => {
    const s = spec()
    s.url = 'https://api.example.com/ping'
    s.options = {
      ...s.options,
      insecure: true,
      connectTimeoutMs: 3000,
      proxy: 'http://127.0.0.1:7890',
      compressed: true
    }
    const notes = buildRequest(s).notes.join()
    expect(notes).toContain('证书')
    expect(notes).toContain('建连超时')
    expect(notes).toContain('代理')
    expect(notes).toContain('compressed')
  })

  it('空值头如实说明"curl 里那是删头"，而不是假装等价', () => {
    const s = spec()
    s.url = 'https://api.example.com/ping'
    s.headers = [param('Accept', '')]
    expect(buildRequest(s).notes.join()).toContain('删掉这个头')
    // fetch 那边确实只能发成空值头 —— 提示是唯一的诚实手段
    expect(headerOf(buildRequest(s).init, 'accept')).toBe('')
  })

  it('rawArgs 不会被浏览器执行，条数与头几个 flag 要说出来', () => {
    const s = spec()
    s.url = 'https://api.example.com/ping'
    s.rawArgs = ["-w '%{http_code}'", '-s', '-o /dev/null', '--retry 3']
    const notes = buildRequest(s).notes.join()
    expect(notes).toContain('4 个 flag')
    expect(notes).toContain('-w')
    expect(notes).toContain('不会执行')
  })

  it('--url-query 项折进 URL 时，如实说明编码表与 curl 不同', () => {
    const s = spec()
    s.url = 'https://api.example.com/s'
    s.query = [{ key: 'g', value: 'hello world', enabled: true, viaUrlQuery: true }]
    const r = buildRequest(s)
    expect(r.url).toBe('https://api.example.com/s?g=hello%20world')
    expect(r.notes.join()).toContain('curl 自己的表把空格编成 +')
  })

  it('一条普通 GET 不该冒出这三条提示（否则每次都喊"做不到"就没人看了）', () => {
    const s = spec()
    s.url = 'https://api.example.com/ping'
    // 默认 spec 自带 --compressed，那条提示是原有的；这里要测的是本轮新加的三条不出现
    s.options = { ...s.options, compressed: false }
    s.query = [param('x', '1')]
    s.headers = [param('X-Key', 'v')]
    expect(buildRequest(s).notes).toEqual([])
  })

  it('相对地址按页面 origin 拼全，否则 fetch 到的是本页', () => {
    const s = spec()
    s.url = '/api/ping'
    s.query = [param('x', '1')]
    expect(buildRequest(s, {}, 'https://tool.example.com/app/index.html').url).toBe(
      'https://tool.example.com/api/ping?x=1'
    )
    // 已经是绝对地址就不动它
    s.url = 'https://in.example.com/api/ping'
    expect(buildRequest(s, {}, 'https://tool.example.com/app/').url).toBe('https://in.example.com/api/ping?x=1')
  })

  it('给了页面地址且目标跨域：发送前就把预检提醒写在 notes 里，并点名触发项', () => {
    const s = spec()
    s.url = 'https://token.sensenova.cn/v1/chat/completions'
    s.method = 'POST'
    s.headers = [param('Content-Type', 'application/json')]
    const notes = buildRequest(s, {}, 'http://localhost:5183/').notes
    const corsNote = notes.find((n) => n.includes('跨域'))
    expect(corsNote).toBeDefined()
    expect(corsNote).toContain('OPTIONS 预检')
    expect(corsNote).toContain('Content-Type: application/json')
  })

  it('同源不给跨域提醒；简单请求给的是"发得出但可能读不到"那一句', () => {
    const same = spec()
    same.url = 'http://localhost:5183/api/ping'
    expect(buildRequest(same, {}, 'http://localhost:5183/').notes.join()).not.toContain('跨域')

    const simple = spec()
    simple.url = 'https://api.example.com/ping'
    const note = buildRequest(simple, {}, 'http://localhost:5183/').notes.find((n) => n.includes('跨域'))
    expect(note).toContain('简单请求')
    expect(note).not.toContain('OPTIONS 预检')
  })

  it('-A 与跨域同时命中时只说一遍：user-agent 作为触发点写在跨域那条里，不再单独立一条', () => {
    const s = spec()
    s.url = 'https://api.example.com/p'
    s.options = { ...s.options, userAgent: 'ops-cli/1.0' }
    const notes = buildRequest(s, {}, 'http://localhost:5183/').notes
    expect(notes.filter((n) => n.includes('user-agent'))).toHaveLength(1)
    expect(notes.some((n) => n.startsWith('设置 -A 会让跨域请求多一次'))).toBe(false)
  })

  it('页面地址取不到（base 为空）时，-A 那句假设性提醒仍要保留——那是此刻唯一能给的线索', () => {
    const s = spec()
    s.url = 'https://api.example.com/p'
    s.options = { ...s.options, userAgent: 'ops-cli/1.0' }
    expect(buildRequest(s).notes.join()).toContain('设置 -A 会让跨域请求多一次')
  })
})

describe('sendSpec', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  /** 固定节奏的计时器，方便断言 ttfb / 总耗时。 */
  const metronome = (...marks: number[]): (() => number) => {
    let i = 0
    return () => (i < marks.length ? (marks[i++] as number) : (marks[marks.length - 1] as number))
  }

  it('正常 JSON：归类、耗时、curl 保留变量原文', async () => {
    const s = spec()
    s.url = 'https://api.example.com/{{path}}'
    let sentUrl = ''
    const report = await sendSpec(s, {
      vars: { path: 'ping' },
      now: metronome(0, 12, 40),
      fetchImpl: (async (input: unknown) => {
        sentUrl = String(input)
        return new Response('{"a":1}', {
          status: 200,
          statusText: 'OK',
          headers: { 'content-type': 'application/json', 'x-request-id': 'r-1' }
        })
      }) as unknown as typeof fetch
    })

    if (!report.outcome.ok) throw new Error('本该成功')
    const resp = report.outcome.response
    expect(resp.status).toBe(200)
    expect(resp.ok).toBe(true)
    expect(resp.kind).toBe('json')
    expect(resp.text).toBe('{"a":1}')
    expect(resp.ttfbMs).toBe(12)
    expect(resp.totalMs).toBe(40)
    expect(resp.truncated).toBe(false)
    expect(resp.sizeExact).toBe(true)
    expect(resp.headers.map((h) => h.name)).toContain('x-request-id')
    // 发出的是解析后的地址，但展示/复制的 curl 仍是变量原文
    expect(sentUrl).toBe('https://api.example.com/ping')
    expect(report.unresolved).toEqual([])
    expect(report.curl).toContain('{{path}}')
  })

  it('没解析的变量如实列出来', async () => {
    const s = spec()
    s.url = 'https://api.example.com/{{path}}'
    const report = await sendSpec(s, {
      now: metronome(0, 1, 1),
      fetchImpl: (async () => new Response('{}', { headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch
    })
    expect(report.unresolved).toEqual(['path'])
  })

  it('fetch 抛错时不编造原因，给 F12 自查路径', async () => {
    const s = spec()
    s.url = 'https://api.example.com/ping'
    s.options = { ...s.options, timeoutMs: 0 }
    const report = await sendSpec(s, {
      now: metronome(0, 1, 1),
      fetchImpl: (async () => {
        throw new TypeError('Failed to fetch')
      }) as unknown as typeof fetch
    })
    expect(report.outcome.ok).toBe(false)
    if (report.outcome.ok) return
    expect(report.outcome.failure.kind).toBe('blocked-or-network')
    expect(report.outcome.failure.hint).toContain('F12')
    expect(report.outcome.failure.raw).toContain('Failed to fetch')
  })

  it('目标跨域且要预检时，失败 hint 直接对上浏览器控制台那句原话', async () => {
    const s = spec()
    s.url = 'https://token.sensenova.cn/v1/chat/completions'
    s.method = 'POST'
    s.headers = [param('Content-Type', 'application/json')]
    s.options = { ...s.options, timeoutMs: 0 }
    const report = await sendSpec(s, {
      pageBase: 'http://localhost:5183/',
      now: metronome(0, 1, 1),
      fetchImpl: (async () => {
        throw new TypeError('Failed to fetch')
      }) as unknown as typeof fetch
    })
    if (report.outcome.ok) throw new Error('本该失败')
    const hint = report.outcome.failure.hint
    expect(hint).toContain("doesn't pass access control check")
    expect(hint).toContain('HTTP ok status')
    expect(hint).toContain('Content-Type: application/json')
    expect(hint).toContain('复制到终端')
    // 发送前的提醒也已经在 notes 里，用户不必等到失败才知道要预检
    expect(report.notes.join()).toContain('OPTIONS 预检')
  })

  it('同源却 fetch 失败：hint 仍是那句"分不清"，不硬编成 CORS', async () => {
    const s = spec()
    s.url = 'http://localhost:5183/api/ping'
    s.options = { ...s.options, timeoutMs: 0 }
    const report = await sendSpec(s, {
      pageBase: 'http://localhost:5183/',
      now: metronome(0, 1, 1),
      fetchImpl: (async () => {
        throw new TypeError('Failed to fetch')
      }) as unknown as typeof fetch
    })
    if (report.outcome.ok) throw new Error('本该失败')
    expect(report.outcome.failure.hint).toContain('分不清')
    expect(report.outcome.failure.hint).not.toContain('sensenova')
  })

  it('外部取消：区分 abort 与网络失败', async () => {
    const ctrl = new AbortController()
    ctrl.abort()
    const s = spec()
    s.url = 'https://api.example.com/ping'
    s.options = { ...s.options, timeoutMs: 0 }
    const report = await sendSpec(s, {
      signal: ctrl.signal,
      now: metronome(0, 1, 1),
      fetchImpl: (async (_u: unknown, init?: RequestInit) => {
        if (init?.signal?.aborted) {
          throw Object.assign(new Error('已取消'), { name: 'AbortError' })
        }
        return new Response('')
      }) as unknown as typeof fetch
    })
    expect(report.outcome.ok).toBe(false)
    if (report.outcome.ok) return
    expect(report.outcome.failure.kind).toBe('abort')
  })

  it('总时限到了就断流，并说明是超时不是服务挂了', async () => {
    vi.useFakeTimers()
    const s = spec()
    s.url = 'https://api.example.com/slow'
    s.options = { ...s.options, timeoutMs: 0 }
    const pending = sendSpec(s, {
      timeoutMs: 5,
      now: metronome(0, 1, 1),
      fetchImpl: ((input: unknown, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(init.signal?.reason ?? new Error('aborted'))
          })
        })) as unknown as typeof fetch
    })
    await vi.advanceTimersByTimeAsync(10)
    const report = await pending
    expect(report.outcome.ok).toBe(false)
    if (report.outcome.ok) return
    expect(report.outcome.failure.kind).toBe('timeout')
    expect(report.outcome.failure.message).toContain('5 ms')
  })

  it('https 页面发 http 目标：浏览器会拦，提前说清不占发送名额', async () => {
    let called = false
    const s = spec()
    s.url = 'http://in.example.com/ping'
    s.options = { ...s.options, timeoutMs: 0 }
    const report = await sendSpec(s, {
      pageBase: 'https://tool.example.com/app/index.html',
      now: metronome(0, 1, 1),
      fetchImpl: (async () => {
        called = true
        return new Response('')
      }) as unknown as typeof fetch
    })
    expect(called).toBe(false)
    expect(report.outcome.ok).toBe(false)
    if (report.outcome.ok) return
    expect(report.outcome.failure.kind).toBe('mixed-content')
    expect(report.curl).toContain('http://in.example.com/ping')
  })

  it('超过 512KB 就断流，只展示前一段并标成"至少这么多"', async () => {
    const chunkA = new Uint8Array(MAX_PREVIEW_BYTES).fill(0x61) // 'a' * 512KB
    const chunkB = new Uint8Array(1024).fill(0x62)
    const stream = new ReadableStream<Uint8Array>({
      start(ctrl2) {
        ctrl2.enqueue(chunkA)
        ctrl2.enqueue(chunkB)
        ctrl2.close()
      }
    })
    const s = spec()
    s.url = 'https://api.example.com/big'
    s.options = { ...s.options, timeoutMs: 0 }
    const report = await sendSpec(s, {
      now: metronome(0, 1, 2),
      fetchImpl: (async () => new Response(stream)) as unknown as typeof fetch
    })
    expect(report.outcome.ok).toBe(true)
    if (!report.outcome.ok) return
    const resp = report.outcome.response
    expect(resp.truncated).toBe(true)
    expect(resp.sizeExact).toBe(false)
    expect(resp.bytes.length).toBe(MAX_PREVIEW_BYTES)
    expect(resp.totalBytes).toBe(MAX_PREVIEW_BYTES + 1024)
    expect(resp.text).toHaveLength(MAX_PREVIEW_BYTES)
  })

  it('图片响应不硬凑文本预览', async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    const s = spec()
    s.url = 'https://api.example.com/logo.png'
    s.options = { ...s.options, timeoutMs: 0 }
    const report = await sendSpec(s, {
      now: metronome(0, 1, 1),
      fetchImpl: (async () =>
        new Response(png, { headers: { 'content-type': 'image/png' } })) as unknown as typeof fetch
    })
    if (!report.outcome.ok) throw new Error('本该成功')
    expect(report.outcome.response.kind).toBe('image')
    expect(report.outcome.response.text).toBe('')
    expect(report.outcome.response.bytes.length).toBe(8)
  })

  it('跨域时响应头被 CORS 过滤，界面要标出"不是服务端没回头"', async () => {
    const corsLimited = {
      status: 200,
      statusText: 'OK',
      ok: true,
      type: 'cors',
      headers: new Headers({ 'content-type': 'application/json' }),
      body: null,
      arrayBuffer: async () => new TextEncoder().encode('{"a":1}').buffer as ArrayBuffer
    } as unknown as Response
    const s = spec()
    s.url = 'https://api.example.com/ping'
    s.options = { ...s.options, timeoutMs: 0 }
    const report = await sendSpec(s, {
      now: metronome(0, 1, 1),
      fetchImpl: (async () => corsLimited) as unknown as typeof fetch
    })
    if (!report.outcome.ok) throw new Error('本该成功')
    const names = report.outcome.response.headers.map((h) => h.name)
    expect(names).toContain('(受限)')
    // content-type 属于 CORS 安全清单，跨域也读得到，所以归类照样准
    expect(report.outcome.response.contentType).toBe('application/json')
    expect(report.curl).toContain('https://api.example.com/ping')
  })
})
