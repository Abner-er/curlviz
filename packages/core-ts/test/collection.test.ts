/**
 * 集合文件（导入导出）+ spec 归一化 + 脱敏单测。
 * 归一化是防御层：导入的 JSON 来自外部，字段可能缺、类型可能错，
 * 不归一就会在用户双击文件那一刻崩在 UI 里，最难查。
 */

import { describe, expect, it } from 'vitest'
import {
  buildCollection,
  hasSensitive,
  normalizeSpec,
  parseCollection,
  redactSpec,
  serializeCollection,
  COLLECTION_FORMAT,
  type CurlSpec
} from '../src/index'
import { parseCurl } from '../src/index'

function makeSpec(patch: Partial<CurlSpec> = {}): CurlSpec {
  return { ...parseCurl("curl 'https://api.example.com/x'").spec, ...patch }
}

describe('normalizeSpec 容错', () => {
  it('空对象也能得到一个结构完整的 spec', () => {
    const spec = normalizeSpec({})
    expect(spec.version).toBe(1)
    expect(spec.method).toBe('GET')
    expect(spec.url).toBe('')
    expect(Array.isArray(spec.headers)).toBe(true)
    expect(spec.body.type).toBe('none')
    expect(spec.auth.type).toBe('none')
    expect(spec.options.connectTimeoutMs).toBe(0)
  })

  it('类型错的字段被丢弃而不是抛异常', () => {
    const spec = normalizeSpec({
      method: 42,
      url: null,
      headers: 'not-an-array',
      query: [{ key: 'ok', value: 1, enabled: 'yes' }, { key: '', value: 'x' }],
      body: { type: 'bogus', json: 5 },
      options: { timeoutMs: 'fast', followRedirects: 'true' }
    })
    expect(spec.method).toBe('GET')
    expect(spec.url).toBe('')
    expect(spec.headers).toEqual([])
    // key 为空的参数丢掉；value/enabled 类型错时退回默认
    expect(spec.query).toEqual([{ key: 'ok', value: '', enabled: true }])
    expect(spec.body.type).toBe('none')
    expect(spec.body.json).toBe('')
    expect(spec.options.timeoutMs).toBe(10000)
    expect(spec.options.followRedirects).toBe(true)
  })

  it('方法名大写归一，空串兜回 GET', () => {
    expect(normalizeSpec({ method: 'post' }).method).toBe('POST')
    expect(normalizeSpec({ method: '' }).method).toBe('GET')
  })

  it('multipart 的 kind 只认 file，其余归 text；空 filename/contentType 不占字段', () => {
    const spec = normalizeSpec({
      body: {
        type: 'multipart',
        multipart: [
          { key: 'f', kind: 'file', value: '/tmp/a', filename: '', contentType: 'image/png' },
          { key: 't', kind: 'weird', value: 'v' }
        ]
      }
    })
    expect(spec.body.multipart[0]).toEqual({ key: 'f', kind: 'file', value: '/tmp/a', contentType: 'image/png', enabled: true })
    expect(spec.body.multipart[1]?.kind).toBe('text')
  })

  it('auth 结构残缺时补齐，不留下 undefined', () => {
    const spec = normalizeSpec({ auth: { type: 'basic' } })
    expect(spec.auth.basic).toEqual({ username: '', password: '' })
    expect(spec.auth.bearer).toEqual({ token: '' })
  })
})

describe('集合读写', () => {
  it('往返：序列化再解析，请求与环境都还在', () => {
    const c = buildCollection([makeSpec({ name: 'A' })], [{ name: 'dev', variables: [{ key: 'host', value: 'h', enabled: true }] }])
    const back = parseCollection(serializeCollection(c))
    expect(back.format).toBe(COLLECTION_FORMAT)
    expect(back.requests[0]?.name).toBe('A')
    expect(back.environments[0]?.variables[0]?.value).toBe('h')
  })

  it('非法 JSON 报"不是合法 JSON"', () => {
    expect(() => parseCollection('{oops')).toThrow(/不是合法 JSON/)
  })

  it('format 不匹配时报错并提示来源，不静默接受', () => {
    expect(() => parseCollection('{"format":"postman","requests":[]}')).toThrow(/curlviz-collection/)
  })

  it('缺 format 也当不匹配处理', () => {
    expect(() => parseCollection('{"requests":[]}')).toThrow(/缺失/)
  })

  it('requests 不是数组时给空数组而不是崩', () => {
    expect(parseCollection(`{"format":"${COLLECTION_FORMAT}","requests":null}`).requests).toEqual([])
  })

  it('紧凑模式不带缩进', () => {
    expect(serializeCollection(buildCollection([]), false)).not.toContain('\n')
  })
})

describe('redactSpec 脱敏', () => {
  it('Authorization / Cookie / api-key 类头被遮盖，普通头不动', () => {
    const spec = makeSpec({
      headers: [
        { key: 'Authorization', value: 'Bearer supersecrettoken', enabled: true },
        { key: 'Cookie', value: 'sid=abcdefghij', enabled: true },
        { key: 'X-Api-Key', value: 'key-1234567890', enabled: true },
        { key: 'Accept', value: 'application/json', enabled: true }
      ]
    })
    const out = redactSpec(spec)
    expect(out.headers[0]?.value).not.toContain('supersecrettoken')
    expect(out.headers[1]?.value).not.toContain('abcdefghij')
    expect(out.headers[2]?.value).not.toContain('1234567890')
    expect(out.headers[3]?.value).toBe('application/json')
  })

  it('auth 字段：basic 遮密码留账号，bearer 遮 token', () => {
    const basic = redactSpec(makeSpec({ auth: { type: 'basic', basic: { username: 'bob', password: 'pw123456' }, bearer: { token: '' } } }))
    expect(basic.auth.basic.username).toBe('bob')
    expect(basic.auth.basic.password).not.toContain('pw123456')
    const bearer = redactSpec(makeSpec({ auth: { type: 'bearer', basic: { username: '', password: '' }, bearer: { token: 'tok-abcdef123456' } } }))
    expect(bearer.auth.bearer.token).not.toContain('abcdef')
  })

  it('query 里的 token/secret/password 类参数值被遮', () => {
    const spec = makeSpec({
      query: [
        { key: 'access_token', value: 'AT-123456789', enabled: true },
        { key: 'page', value: '2', enabled: true }
      ]
    })
    const out = redactSpec(spec)
    expect(out.query[0]?.value).not.toContain('123456789')
    expect(out.query[1]?.value).toBe('2')
  })

  it('rawArgs 里的凭据型 flag 也被遮（解析失败的命令同样会进历史）', () => {
    const spec = makeSpec({ rawArgs: ['-u bob:pw123456', '--retry 3', "-H 'Cookie: sid=abcdefghij'", "-H 'Accept: text/html'"] })
    const out = redactSpec(spec)
    expect(out.rawArgs[0]).not.toContain('pw123456')
    expect(out.rawArgs[1]).toBe('--retry 3')
    expect(out.rawArgs[2]).not.toContain('abcdefghij')
    expect(out.rawArgs[3]).toBe("-H 'Accept: text/html'")
  })

  it('短名与长名等价处理，未知 flag 不误伤', () => {
    const spec = makeSpec({ rawArgs: ['--proxy-user p:u', '--cacert ./ca.pem', '--http2'] })
    const out = redactSpec(spec)
    expect(out.rawArgs[0]).not.toContain('p:u')
    expect(out.rawArgs[1]).toBe('--cacert ./ca.pem')
    expect(out.rawArgs[2]).toBe('--http2')
  })

  it('脱敏不改原对象（历史列表要能同时出"原样"和"脱敏"两种视图）', () => {
    const spec = makeSpec({ auth: { type: 'bearer', basic: { username: '', password: '' }, bearer: { token: 'abc123456' } } })
    const before = JSON.stringify(spec)
    redactSpec(spec)
    expect(JSON.stringify(spec)).toBe(before)
  })

  it('hasSensitive 认得出需要脱敏的 spec', () => {
    expect(hasSensitive(makeSpec({ auth: { type: 'bearer', basic: { username: '', password: '' }, bearer: { token: 'x' } } }))).toBe(true)
    expect(hasSensitive(makeSpec({ headers: [{ key: 'Cookie', value: 'a=b', enabled: true }] }))).toBe(true)
    expect(hasSensitive(makeSpec())).toBe(false)
  })
})
