import { describe, expect, it } from 'vitest'
import type { CurlSpec } from '../src/index'
import { buildArgv, createDefaultSpec, generateCurl, parseCurl, tokenizeWords } from '../src/index'

/** 造一条最简 spec：只改 URL，其余留默认，测试聚焦在本函数的凭据搬运与 argv 拼装。 */
function baseSpec(): CurlSpec {
  const s = createDefaultSpec('t')
  s.url = 'https://x.test/p'
  return s
}

describe('buildArgv：argv 就是复制到终端那条的词表', () => {
  it('URL 是 argv 首个 token；无凭据时不带 --config', () => {
    const spec = parseCurl("curl 'https://api.example.com/items?x=1'").spec
    const { argv, stdinConfig } = buildArgv(spec)
    expect(argv[0]).toBe('https://api.example.com/items?x=1')
    expect(argv).not.toContain('--config')
    expect(stdinConfig).toBe('')
  })

  it('header / json body 的值不带 shell 引号（tokenize 已剥）', () => {
    const spec = parseCurl(
      "curl 'https://x.test/p' -X POST -H 'Content-Type: application/json' --data-raw '{\"a\":1}'"
    ).spec
    const { argv } = buildArgv(spec)
    expect(argv).toContain('Content-Type: application/json')
    expect(argv).toContain('{"a":1}')
    expect(argv.some((t) => t.includes("'"))).toBe(false)
  })

  it('无凭据时：[curl, ...argv] 逐 token 等于 generateCurl 单行版分词', () => {
    const spec = parseCurl(
      "curl 'https://x.test/p?a=1&b=2' -L -m 30 -H 'Accept: application/json' --data-raw '{\"k\":1}'"
    ).spec
    const tokens = tokenizeWords(generateCurl(spec, { multiline: false })).map((t) => t.value)
    const { argv, stdinConfig } = buildArgv(spec)
    expect(stdinConfig).toBe('')
    expect(['curl', ...argv]).toEqual(tokens)
  })
})

describe('buildArgv：凭据一律转 stdin，不进 argv / ps', () => {
  it('basic auth：argv 无明文口令，stdinConfig 有 user 行，argv 头带 --config -', () => {
    const spec = baseSpec()
    spec.auth = { type: 'basic', basic: { username: 'bob', password: 'secretpw' }, bearer: { token: '' } }
    const { argv, stdinConfig } = buildArgv(spec)
    expect(argv.join(' ')).not.toContain('secretpw')
    expect(stdinConfig).toBe('user = "bob:secretpw"\n')
    expect(argv.slice(0, 2)).toEqual(['--config', '-'])
  })

  it('bearer：Authorization 转 stdin，argv 无 token', () => {
    const spec = baseSpec()
    spec.auth = { type: 'bearer', basic: { username: '', password: '' }, bearer: { token: 'TOKEN123' } }
    const { argv, stdinConfig } = buildArgv(spec)
    expect(argv.join(' ')).not.toContain('TOKEN123')
    expect(stdinConfig).toBe('header = "Authorization: Bearer TOKEN123"\n')
  })

  it('Cookie 头转 stdin', () => {
    const spec = baseSpec()
    spec.headers = [{ key: 'Cookie', value: 'session=abc123', enabled: true }]
    const { argv, stdinConfig } = buildArgv(spec)
    expect(argv.join(' ')).not.toContain('abc123')
    expect(stdinConfig).toBe('header = "Cookie: session=abc123"\n')
  })

  it('非敏感的自定义头留在 argv（只有 Authorization/Cookie 类才搬走）', () => {
    const spec = baseSpec()
    spec.headers = [{ key: 'X-Requested-By', value: 'curl', enabled: true }]
    const { argv, stdinConfig } = buildArgv(spec)
    expect(argv).toContain('X-Requested-By: curl')
    expect(stdinConfig).toBe('')
  })

  it('proxy 带凭据：口令转 stdin，proxy 地址留 argv', () => {
    const spec = baseSpec()
    spec.options.proxy = 'http://puser:ppass@proxy.internal:3128'
    const { argv, stdinConfig } = buildArgv(spec)
    expect(argv.join(' ')).not.toContain('ppass')
    expect(argv).toContain('http://proxy.internal:3128')
    expect(stdinConfig).toBe('proxy-user = "puser:ppass"\n')
  })

  it('无凭据的 proxy 原样进 argv，不转 stdin', () => {
    const spec = baseSpec()
    spec.options.proxy = 'socks5://proxy.internal:1080'
    const { argv, stdinConfig } = buildArgv(spec)
    expect(argv).toContain('socks5://proxy.internal:1080')
    expect(stdinConfig).toBe('')
  })
})

describe('buildArgv：curl config 值转义', () => {
  it('口令里的 % 双写成 %%，避免 curl 环境变量替换', () => {
    const spec = baseSpec()
    spec.auth = { type: 'basic', basic: { username: 'usr', password: 'p%w' }, bearer: { token: '' } }
    const { stdinConfig } = buildArgv(spec)
    expect(stdinConfig).toBe('user = "usr:p%%w"\n')
  })
})

describe('buildArgv：rawArgs 在 agent 路径照常执行', () => {
  it('带 bash 引号的 rawArg 被剥成干净 token 进 argv', () => {
    const spec = baseSpec()
    spec.rawArgs = ["-H 'foo;'"]
    const { argv } = buildArgv(spec)
    expect(argv).toContain('foo;')
    expect(argv).not.toContain("-H 'foo;'")
  })

  it('普通 rawArg（如 -s）原样进 argv', () => {
    const spec = baseSpec()
    spec.rawArgs = ['-s']
    const { argv } = buildArgv(spec)
    expect(argv).toContain('-s')
  })
})
