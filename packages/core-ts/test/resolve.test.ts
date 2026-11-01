import { describe, expect, it } from 'vitest'
import { generateCurl, normalizeSpec, parseCurl, parseResolveEntry } from '../src/index'

/**
 * `--resolve` 的判据专项。契约 fixture（spec/fixtures/resolve.json）钉的是"命令 ↔ spec"
 * 的往返；这里钉的是**判据本身**——parseResolveEntry 在合法/非法边界上的取舍，
 * 以及"不合法就不结构化、留 rawArgs"这条安全取向真的落地了。
 */

describe('parseResolveEntry 判据（抄自 curl 8.19.0 实测）', () => {
  it('合法：IPv4 / 端口 / host', () => {
    expect(parseResolveEntry('api.internal:80:10.0.0.5')).toEqual({
      host: 'api.internal',
      port: 80,
      addr: '10.0.0.5'
    })
  })

  it('合法：IPv6 不带方括号，第二个冒号后全是 addr', () => {
    expect(parseResolveEntry('v6.test:80:2001:db8::1')).toEqual({
      host: 'v6.test',
      port: 80,
      addr: '2001:db8::1'
    })
  })

  it('合法：IPv6 带方括号，addr 原样保留（含括号）', () => {
    const e = parseResolveEntry('v6.test:443:[::1]')
    expect(e).toEqual({ host: 'v6.test', port: 443, addr: '[::1]' })
  })

  it('合法：端口 0（curl 能解析，只是连不上）', () => {
    expect(parseResolveEntry('a:0:127.0.0.1')).toEqual({ host: 'a', port: 0, addr: '127.0.0.1' })
  })

  // 以下全部对应 curl 的 `curl: (49) Could not parse` —— 我们一律返回 null 让调用方留 rawArgs
  it('非法：addr 是主机名（实测 49）', () => {
    expect(parseResolveEntry('a:80:localhost')).toBeNull()
  })
  it('非法：端口非数字（实测 49）', () => {
    expect(parseResolveEntry('a:http:127.0.0.1')).toBeNull()
  })
  it('非法：IPv4 后多余段（实测 49）', () => {
    expect(parseResolveEntry('a:80:127.0.0.1:extra')).toBeNull()
  })
  it('非法：端口越界 >65535', () => {
    expect(parseResolveEntry('a:70000:127.0.0.1')).toBeNull()
  })
  it('非法：IPv4 段 >255', () => {
    expect(parseResolveEntry('a:80:999.999.999.999')).toBeNull()
  })
  it('非法：缺 addr 段 / 缺端口段 / host 空', () => {
    expect(parseResolveEntry('a:80')).toBeNull()
    expect(parseResolveEntry('a')).toBeNull()
    expect(parseResolveEntry(':80:127.0.0.1')).toBeNull()
  })
  it('非法：addr 空', () => {
    expect(parseResolveEntry('a:80:')).toBeNull()
  })
  it('IPv4 前导零不猜（保守留 rawArgs）', () => {
    expect(parseResolveEntry('a:80:01.2.3.4')).toBeNull()
  })
})

describe('parseCurl：--resolve 结构化，非法降级 rawArgs', () => {
  it('单条 --resolve 进 options.resolve，不进 rawArgs', () => {
    const { spec } = parseCurl(`curl 'http://a.test/' --resolve 'a.test:80:10.0.0.5'`)
    expect(spec.options.resolve).toEqual([{ host: 'a.test', port: 80, addr: '10.0.0.5' }])
    expect(spec.rawArgs).toEqual([])
  })

  it('多条按出现顺序累积', () => {
    const { spec } = parseCurl(
      `curl 'http://a.test/' --resolve 'a.test:80:10.0.0.5' --resolve 'b.test:443:10.0.0.9'`
    )
    expect(spec.options.resolve.map((r) => r.host)).toEqual(['a.test', 'b.test'])
  })

  it('非法值原样留 rawArgs，options.resolve 保持空', () => {
    const { spec } = parseCurl(`curl 'http://a.test/' --resolve 'a.test:80:localhost'`)
    expect(spec.options.resolve).toEqual([])
    expect(spec.rawArgs).toEqual([`--resolve 'a.test:80:localhost'`])
  })
})

describe('normalizeSpec：读旧写新（把 rawArgs 里的 --resolve 抬进 options.resolve）', () => {
  it('旧集合 JSON 里 --resolve 带单引号 → 抬进 options.resolve，rawArgs 清空', () => {
    const spec = normalizeSpec({
      url: 'http://a.test/',
      options: { resolve: [] },
      rawArgs: [`--resolve 'a.test:80:10.0.0.5'`]
    })
    expect(spec.options.resolve).toEqual([{ host: 'a.test', port: 80, addr: '10.0.0.5' }])
    expect(spec.rawArgs).toEqual([])
  })

  it('抬不动的（addr 非法）留在 rawArgs', () => {
    const spec = normalizeSpec({
      url: 'http://a.test/',
      rawArgs: [`--resolve 'a.test:80:localhost'`]
    })
    expect(spec.options.resolve).toEqual([])
    expect(spec.rawArgs).toEqual([`--resolve 'a.test:80:localhost'`])
  })

  it('已结构化的 resolve 数组里坏条目被丢弃、好条目留下', () => {
    const spec = normalizeSpec({
      url: 'http://a.test/',
      options: {
        resolve: [
          { host: 'a.test', port: 80, addr: '10.0.0.5' },
          { host: 'b.test', port: 80, addr: 'notanip' },
          { host: '', port: 80, addr: '10.0.0.6' }
        ]
      }
    })
    expect(spec.options.resolve).toEqual([{ host: 'a.test', port: 80, addr: '10.0.0.5' }])
  })
})

describe('generateCurl：--resolve 位置与形态', () => {
  it('排在选项段末尾（-x 之后），addr 原样', () => {
    const { spec } = parseCurl(`curl 'https://a.test/' -k -x 'http://p:1' --resolve 'a.test:443:[::1]'`)
    const out = generateCurl(spec, { multiline: false })
    expect(out).toBe(`curl 'https://a.test/' -k -x 'http://p:1' --resolve 'a.test:443:[::1]'`)
  })

  it('空 resolve 数组不输出 --resolve', () => {
    const { spec } = parseCurl(`curl 'https://a.test/'`)
    expect(generateCurl(spec, { multiline: false })).not.toContain('--resolve')
  })
})
