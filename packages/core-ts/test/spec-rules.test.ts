import { describe, expect, it } from 'vitest'
import {
  buildUrlWithQuery,
  createDefaultSpec,
  generateCurl,
  generateCurlSingleLine,
  type CurlSpec
} from '../src/index'

/**
 * spec/README §4（生成方向规则）逐条钉住。
 *
 * 这份测试不追求覆盖率，它追求的是"规范里写的每条输出规则，都有对应断言"：
 * Kotlin 侧将来照同一节实现，任何一端偷偷改行为都会在这里先炸。
 * 每条用例标了规范小节，改代码的人得先去改文档。
 */

function blank(): CurlSpec {
  const spec = createDefaultSpec('规则用例')
  spec.url = 'https://api.example.com/ping'
  spec.options = {
    followRedirects: false,
    insecure: false,
    compressed: false,
    timeoutMs: 0,
    connectTimeoutMs: 0,
    userAgent: '',
    proxy: ''
  }
  return spec
}

describe('§4.1 输出顺序', () => {
  it('curl URL → 方法 → 选项 → headers → auth → 自动CT → body → rawArgs', () => {
    const spec = blank()
    spec.method = 'POST'
    spec.options = { ...spec.options, followRedirects: true, insecure: true, timeoutMs: 5000 }
    spec.headers = [{ key: 'X-A', value: '1', enabled: true }]
    spec.auth = { type: 'basic', basic: { username: 'u', password: 'p' }, bearer: { token: '' } }
    spec.body = { ...spec.body, type: 'json', json: '{"a":1}' }
    spec.rawArgs = ['-o', '/dev/null']

    const line = generateCurlSingleLine(spec)
    const order = [
      'curl ',
      '-X POST',
      '-L',
      '-k',
      '-m 5',
      "-H 'X-A: 1'",
      "-u 'u:p'",
      "-H 'Content-Type: application/json'",
      "--data-raw '{\"a\":1}'",
      '-o /dev/null'
    ]
    let at = -1
    for (const piece of order) {
      const next = line.indexOf(piece, at + 1)
      expect(next, `顺序里缺 ${piece}：${line}`).toBeGreaterThan(at)
      at = next
    }
  })

  it('HEAD 出 -I，其它非 GET 出 -X；GET 什么都不带', () => {
    const head = blank()
    head.method = 'HEAD'
    expect(generateCurlSingleLine(head)).toBe("curl 'https://api.example.com/ping' -I")

    const del = blank()
    del.method = 'delete'
    expect(generateCurlSingleLine(del)).toContain('-X DELETE')

    expect(generateCurlSingleLine(blank())).toBe("curl 'https://api.example.com/ping'")
  })

  it('多行两空格缩进、行尾反斜杠，注释行不带续行符', () => {
    const spec = blank()
    spec.headers = [
      { key: 'X-A', value: '1', enabled: true },
      { key: 'X-B', value: '2', enabled: true }
    ]
    const text = generateCurl(spec, { multiline: true, withNameComment: true })
    const lines = text.split('\n')
    expect(lines[0]).toBe('# 规则用例')
    expect(lines[1]).toBe("curl 'https://api.example.com/ping' \\")
    expect(lines[2]).toBe("  -H 'X-A: 1' \\")
    expect(lines[3]).toBe("  -H 'X-B: 2'")
  })
})

describe('§4.2 引号风格', () => {
  it("posix：单引号包裹，内部单引号走 '\\'' 技巧", () => {
    const spec = blank()
    spec.headers = [{ key: 'X', value: "it's", enabled: true }]
    expect(generateCurlSingleLine(spec)).toContain(`-H 'X: it'\\''s'`)
  })

  it('windows：双引号包裹，内部反斜杠翻倍、双引号转义，不碰单引号', () => {
    const spec = blank()
    spec.body = { ...spec.body, type: 'raw', raw: String.raw`C:\path "q" it's` }
    expect(generateCurlSingleLine(spec, { quoteStyle: 'windows' })).toBe(
      String.raw`curl "https://api.example.com/ping" --data-binary "C:\\path \"q\" it's"`
    )
  })
})

describe('§4.3 三条硬约束', () => {
  it('变量段永不被 percent-encode，其余照常编码', () => {
    const spec = blank()
    spec.url = 'https://api.example.com/{{path}}'
    spec.query = [{ key: 'q', value: '{{token}} a&b', enabled: true }]
    expect(buildUrlWithQuery(spec.url, spec.query)).toBe('https://api.example.com/{{path}}?q={{token}}%20a%26b')
  })

  it('auth 非 none 时同名 Authorization 头不再输出（否则 curl 发两个认证头）', () => {
    const spec = blank()
    spec.headers = [{ key: 'Authorization', value: 'Basic Zm9vOmJhcg==', enabled: true }]
    spec.auth = { type: 'bearer', basic: { username: '', password: '' }, bearer: { token: 'tok' } }
    const line = generateCurlSingleLine(spec)
    expect(line.match(/Authorization/g)).toHaveLength(1)
    expect(line).toContain("Bearer tok")
  })

  it('multipart 文本值含 ; @ < 时退回 --form-string，别让 -F 把数据当指令', () => {
    const spec = blank()
    spec.method = 'POST'
    spec.body = {
      ...spec.body,
      type: 'multipart',
      multipart: [
        { key: 'plain', kind: 'text', value: 'v', enabled: true },
        { key: 'semi', kind: 'text', value: 'a;b', enabled: true },
        { key: 'at', kind: 'text', value: '@not-a-file', enabled: true },
        { key: 'lt', kind: 'text', value: '<x', enabled: true },
        { key: 'f', kind: 'file', value: 'D:/a.txt', filename: 'a.txt', contentType: 'text/plain', enabled: true }
      ]
    }
    const line = generateCurlSingleLine(spec)
    expect(line).toContain("-F 'plain=v'")
    expect(line).toContain("--form-string 'semi=a;b'")
    expect(line).toContain("--form-string 'at=@not-a-file'")
    expect(line).toContain("--form-string 'lt=<x'")
    expect(line).toContain("-F 'f=@D:/a.txt;filename=a.txt;type=text/plain'")
  })
})

describe('§4.4 其它映射', () => {
  it('query 禁用行与空键名不输出；URL 已带 ? 时用 & 续接', () => {
    const spec = blank()
    spec.url = 'https://api.example.com/ping?a=1'
    spec.query = [
      { key: 'b', value: '2', enabled: true },
      { key: 'c', value: '3', enabled: false },
      { key: '', value: 'ghost', enabled: true }
    ]
    expect(generateCurlSingleLine(spec)).toBe("curl 'https://api.example.com/ping?a=1&b=2'")
  })

  it('header 值为空串输出 -H \'K:\'（curl 语义是发空值头，不是删头）', () => {
    const spec = blank()
    spec.headers = [{ key: 'X-Empty', value: '', enabled: true }]
    expect(generateCurlSingleLine(spec)).toBe("curl 'https://api.example.com/ping' -H 'X-Empty:'")
  })

  it('form 体逐项编码后拼一条 -d，且不自动补 Content-Type（curl 自己会带 urlencoded）', () => {
    const spec = blank()
    spec.method = 'POST'
    spec.body = {
      ...spec.body,
      type: 'form',
      form: [
        { key: 'q', value: 'a b&c', enabled: true },
        { key: 't', value: '{{tok}}', enabled: true }
      ]
    }
    const line = generateCurlSingleLine(spec)
    expect(line).toContain("-d 'q=a%20b%26c&t={{tok}}'")
    expect(line).not.toContain('Content-Type')
  })

  it('json 体自动补 Content-Type，用户自己写了就不补', () => {
    const spec = blank()
    spec.method = 'POST'
    spec.body = { ...spec.body, type: 'json', json: '{"a":1}' }
    expect(generateCurlSingleLine(spec)).toContain("-H 'Content-Type: application/json'")

    spec.headers = [{ key: 'Content-Type', value: 'application/vnd.x+json', enabled: true }]
    const line = generateCurlSingleLine(spec)
    expect(line.match(/Content-Type/g)).toHaveLength(1)
    expect(line).toContain('application/vnd.x+json')
  })

  it('空 body 各形态都不输出（json 只有一串空白也算空）', () => {
    const spec = blank()
    spec.method = 'POST'
    for (const variant of [
      { type: 'json' as const, json: '   ' },
      { type: 'raw' as const, raw: '' },
      { type: 'form' as const, form: [] as never },
      { type: 'multipart' as const, multipart: [] as never }
    ]) {
      spec.body = { ...spec.body, ...variant }
      expect(generateCurlSingleLine(spec)).toBe("curl 'https://api.example.com/ping' -X POST")
    }
  })

  it('超时：总时限走 -m，建连上限走 --connect-timeout，毫秒按需转秒', () => {
    const spec = blank()
    spec.options = { ...spec.options, timeoutMs: 1500, connectTimeoutMs: 3000 }
    const line = generateCurlSingleLine(spec)
    expect(line).toContain('-m 1.5')
    expect(line).toContain('--connect-timeout 3')
  })
})
