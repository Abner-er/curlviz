/**
 * 变量替换单测：`{{name}}` 的作用域、未解析的处理、转义形态、集合优先级。
 * 核心安全点：未解析变量必须原样保留并报名字——悄悄替换成空串会发出一个
 * 打到错误地址的请求，比报错危险得多。
 */

import { describe, expect, it } from 'vitest'
import {
  extractVars,
  findUnresolvedVars,
  parseCurl,
  resolveSpec,
  resolveText,
  toVarMap,
  type Environment
} from '../src/index'

const env = (name: string, vars: Record<string, string>, disabled: string[] = []): Environment => ({
  name,
  variables: Object.entries(vars).map(([key, value]) => ({
    key,
    value,
    enabled: !disabled.includes(key)
  }))
})

describe('resolveText', () => {
  it('命中即替换，多处同变量都替换', () => {
    expect(resolveText('{{h}}/a/{{h}}', { h: 'x.io' }).text).toBe('x.io/a/x.io')
  })

  it('变量名两侧空白容忍', () => {
    expect(resolveText('{{ host }}', { host: 'x' }).text).toBe('x')
  })

  it('未解析：原样保留 + 报名字（不替换成空串）', () => {
    const r = resolveText('{{host}}/api', {})
    expect(r.text).toBe('{{host}}/api')
    expect(r.unresolved).toEqual(['host'])
  })

  it('值为空串算已解析，且不算未解析', () => {
    const r = resolveText('a{{x}}b', { x: '' })
    expect(r.text).toBe('ab')
    expect(r.unresolved).toEqual([])
  })

  it('替换是单趟扫描：变量值里的 {{x}} 不会被二次展开', () => {
    const r = resolveText('{{a}}', { a: '{{b}}', b: 'NOPE' })
    expect(r.text).toBe('{{b}}')
    expect(r.unresolved).toEqual([])
  })

  it('反斜杠转义 \\{{x}} 不替换，还原为字面量', () => {
    const r = resolveText('\\{{item.name}}', { 'item.name': 'X' })
    expect(r.text).toBe('{{item.name}}')
    expect(r.unresolved).toEqual([])
  })
})

describe('extractVars', () => {
  it('去重保序', () => {
    expect(extractVars('{{a}}-{{b}}-{{a}}')).toEqual(['a', 'b'])
  })

  it('转义形态不计入', () => {
    expect(extractVars('a \\{{lit}} {{real}}')).toEqual(['real'])
  })

  it('非法变量名不当变量', () => {
    expect(extractVars('{{a b}} {{ok-x_1.2}}')).toEqual(['ok-x_1.2'])
  })
})

describe('resolveSpec 覆盖全部字符串位', () => {
  const base = () =>
    parseCurl(
      [
        "curl '{{host}}/api?token={{token}}'",
        `-H 'Authorization: Bearer {{bearer}}'`,
        '-H "X-Trace: {{trace}}"',
        "--data-raw '{\"pw\":\"{{pass}}\"}'",
        "-A '{{ua}}'",
        '-x {{proxy}}',
        '--retry {{retry}}'
      ].join(' ')
    ).spec

  it('url / query / header / body / auth / userAgent / proxy / rawArgs 全替换', () => {
    const { spec, unresolved } = resolveSpec(base(), {
      host: 'h',
      token: 'T',
      bearer: 'B',
      trace: 'TR',
      pass: 'P',
      ua: 'UA',
      proxy: 'http://p:1',
      retry: 'RT'
    })
    expect(unresolved).toEqual([])
    expect(spec.url).toBe('h/api')
    expect(spec.query[0]?.value).toBe('T')
    expect(spec.auth.bearer.token).toBe('B')
    expect(spec.headers.some((h) => h.value.includes('TR'))).toBe(true)
    expect(spec.body.json).toBe('{"pw":"P"}')
    expect(spec.options.userAgent).toBe('UA')
    expect(spec.options.proxy).toBe('http://p:1')
    expect(spec.rawArgs.join(' ')).toContain('RT')
  })

  it('auth 头折叠后 auth 字段里也要做替换', () => {
    const { spec } = resolveSpec(parseCurl("curl 'https://x' -u '{{u}}:{{p}}'").spec, { u: 'bob', p: 'pw' })
    expect(spec.auth.basic).toEqual({ username: 'bob', password: 'pw' })
  })

  it('multipart 的 value/filename/contentType 都替换', () => {
    const spec = parseCurl("curl 'https://x' -F 'f=@{{path}};type={{type}}'").spec
    const { spec: out } = resolveSpec(spec, { path: '/tmp/a.png', type: 'image/png' })
    expect(out.body.multipart[0]?.value).toBe('/tmp/a.png')
    expect(out.body.multipart[0]?.contentType).toBe('image/png')
  })

  it('返回副本，原 spec 不被改写（编辑态与发送态必须是两份）', () => {
    const original = parseCurl("curl '{{host}}/x'").spec
    const before = JSON.stringify(original)
    resolveSpec(original, { host: 'h' })
    expect(JSON.stringify(original)).toBe(before)
  })

  it('未解析变量集中回报且去重', () => {
    const { unresolved } = resolveSpec(parseCurl("curl '{{a}}/{{b}} {{a}}'").spec, {})
    expect(unresolved.sort()).toEqual(['a', 'b'])
  })
})

describe('findUnresolvedVars（发送前校验）', () => {
  it('只报没值的，有值的不报', () => {
    const spec = parseCurl("curl '{{host}}/{{known}}'").spec
    expect(findUnresolvedVars(spec, { host: 'h', known: '' }).sort()).toEqual([])
    expect(findUnresolvedVars(spec, {})).toEqual(['host', 'known'])
  })
})

describe('toVarMap 环境优先级', () => {
  it('活动环境的同名变量覆盖其它环境', () => {
    const list = [env('dev', { host: 'dev.example.com' }), env('prod', { host: 'prod.example.com' })]
    expect(toVarMap(list, 'prod')['host']).toBe('prod.example.com')
    expect(toVarMap(list, 'dev')['host']).toBe('dev.example.com')
  })

  it('没有活动环境时按声明顺序后者覆盖前者', () => {
    const list = [env('a', { k: '1' }), env('b', { k: '2' })]
    expect(toVarMap(list)['k']).toBe('2')
  })

  it('enabled=false 的变量不参与替换（临时停用而不删值）', () => {
    const list = [env('a', { k: 'on', off: 'x' }, ['off'])]
    const map = toVarMap(list, 'a')
    expect(map['k']).toBe('on')
    expect(map['off']).toBeUndefined()
  })
})
