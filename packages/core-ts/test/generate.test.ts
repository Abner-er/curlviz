/**
 * 生成方向单测：引号、顺序、自动 Content-Type、变量保留、Windows 风格、多行/单行。
 * 起点统一用 parseCurl 拿一份"无默认开关"的干净 spec，再改字段——
 * 不用 createDefaultSpec，否则 -L / --compressed / -m 10 这些 UI 默认会混进期望值里。
 */

import { describe, expect, it } from 'vitest'
import { generateCurl, generateCurlSingleLine, parseCurl, type CurlSpec } from '../src/index'

/** 干净基线：GET + 无选项 + 无 header/body。 */
function blank(url = 'https://api.example.com/x'): CurlSpec {
  return parseCurl(`curl '${url}'`).spec
}

describe('整体结构与顺序', () => {
  it('最简形态只有一行', () => {
    expect(generateCurl(blank())).toBe("curl 'https://api.example.com/x'")
  })

  it('顺序固定：URL → 方法 → 选项 → headers → auth → body → rawArgs', () => {
    const spec = blank()
    spec.method = 'PATCH'
    spec.options.followRedirects = true
    spec.options.insecure = true
    spec.headers.push({ key: 'Accept', value: 'application/json', enabled: true })
    spec.auth = { type: 'bearer', bearer: { token: 'TOK' }, basic: { username: '', password: '' } }
    spec.body.type = 'json'
    spec.body.json = '{"a":1}'
    spec.rawArgs.push('--retry 3')
    expect(generateCurl(spec).split('\n').map((l) => l.trim())).toEqual([
      "curl 'https://api.example.com/x' \\",
      '-X PATCH \\',
      '-L \\',
      '-k \\',
      "-H 'Accept: application/json' \\",
      "-H 'Authorization: Bearer TOK' \\",
      '-H \'Content-Type: application/json\' \\',
      `--data-raw '{"a":1}' \\`,
      '--retry 3'
    ])
  })

  it('默认多行：行尾续行符 + 两空格缩进', () => {
    const spec = blank()
    spec.headers.push({ key: 'A', value: 'b', enabled: true })
    expect(generateCurl(spec)).toBe("curl 'https://api.example.com/x' \\\n  -H 'A: b'")
  })

  it('单行模式无续行符', () => {
    const spec = blank()
    spec.headers.push({ key: 'A', value: 'b', enabled: true })
    expect(generateCurlSingleLine(spec)).toBe("curl 'https://api.example.com/x' -H 'A: b'")
  })

  it('HEAD 输出 -I，不输出 -X HEAD（后者会让 curl 死等响应体）', () => {
    const spec = blank()
    spec.method = 'HEAD'
    expect(generateCurlSingleLine(spec)).toBe("curl 'https://api.example.com/x' -I")
  })

  it('GET 不输出 -X', () => {
    const spec = blank()
    spec.method = 'GET'
    expect(generateCurl(spec)).not.toContain('-X')
  })

  it('方法名大小写归一', () => {
    const spec = blank()
    spec.method = 'post'
    expect(generateCurl(spec)).toContain('-X POST')
  })

  it('withNameComment 在首行加请求名（导出 .sh 用）', () => {
    const spec = blank()
    spec.name = '健康检查'
    expect(generateCurl(spec, { withNameComment: true }).split('\n')[0]).toBe('# 健康检查')
  })

  it('mergeQueryIntoUrl:false 时 query 不进 URL（给 UI 展示 query 编辑区用）', () => {
    const spec = blank()
    spec.query.push({ key: 'p', value: '1', enabled: true })
    expect(generateCurl(spec, { mergeQueryIntoUrl: false })).toBe("curl 'https://api.example.com/x'")
    expect(generateCurl(spec)).toBe("curl 'https://api.example.com/x?p=1'")
  })

  it('空 URL 也不崩，输出空串占位', () => {
    expect(generateCurl(blank(''))).toBe("curl ''")
  })
})

describe('引号与转义', () => {
  it("POSIX：值里的单引号转成 '\\''", () => {
    const spec = blank()
    spec.headers.push({ key: 'X', value: "it's", enabled: true })
    expect(generateCurl(spec)).toBe("curl 'https://api.example.com/x' \\\n  -H 'X: it'\\''s'")
  })

  it('POSIX：含换行的值原样进单引号（bash 合法）', () => {
    const spec = blank()
    spec.body.type = 'raw'
    spec.body.raw = 'a\nb'
    // GET + body 必须显式 `-X GET`：实测 curl 见到 -d/--data* 就自己发 POST，
    // 少了这个 flag，"GET 带 body" 的意图会静默变成 POST。
    expect(generateCurl(spec)).toBe("curl 'https://api.example.com/x' \\\n  -X GET \\\n  --data-binary 'a\nb'")
  })

  it('Windows：双引号包裹，内部双引号转义，单引号无需处理', () => {
    const spec = blank()
    spec.body.type = 'json'
    spec.body.json = '{"a":"it\'s"}'
    const out = generateCurl(spec, { quoteStyle: 'windows' })
    expect(out).toContain(`--data-raw "{\\"a\\":\\"it's\\"}"`)
    expect(out).toContain('curl "https://api.example.com/x"')
  })

  it('Windows：反斜杠先 doubled 再转义引号，避免 \\ 与 \\" 混淆', () => {
    const spec = blank('https://host/x')
    spec.headers.push({ key: 'X', value: 'a\\b"c', enabled: true })
    const out = generateCurl(spec, { quoteStyle: 'windows' })
    expect(out).toContain('-H "X: a\\\\b\\"c"')
  })

  it('空值头输出 `K:`（curl 语义是发空值头，不是删头）', () => {
    const spec = blank()
    spec.headers.push({ key: 'X-Empty', value: '', enabled: true })
    expect(generateCurl(spec)).toBe("curl 'https://api.example.com/x' \\\n  -H 'X-Empty:'")
  })

  it('enabled=false 的 header 不输出', () => {
    const spec = blank()
    spec.headers.push({ key: 'A', value: '1', enabled: false }, { key: 'B', value: '2', enabled: true })
    expect(generateCurl(spec)).toBe("curl 'https://api.example.com/x' \\\n  -H 'B: 2'")
  })
})

describe('URL 与 query 编码', () => {
  it('query 拼进 URL，键值都编码', () => {
    const spec = blank('https://api.example.com/s')
    spec.query.push({ key: 'q', value: 'a b&c', enabled: true })
    expect(generateCurl(spec)).toBe("curl 'https://api.example.com/s?q=a%20b%26c'")
  })

  it('URL 已带 ? 时用 & 续接', () => {
    const spec = blank('https://api.example.com/s?page=1')
    spec.query.push({ key: 'q', value: 'x', enabled: true })
    expect(generateCurl(spec)).toBe("curl 'https://api.example.com/s?page=1&q=x'")
  })

  it('{{变量}} 绝不被 percent-encode（否则命令直接废）', () => {
    const spec = blank('https://{{host}}/api')
    spec.query.push({ key: 't', value: '{{token}}', enabled: true })
    expect(generateCurl(spec)).toBe("curl 'https://{{host}}/api?t={{token}}'")
  })

  it('变量与普通文本混排也只编码普通部分', () => {
    const spec = blank('https://api/x')
    spec.query.push({ key: 'q', value: '{{v}}中文', enabled: true })
    expect(generateCurl(spec)).toBe("curl 'https://api/x?q={{v}}%E4%B8%AD%E6%96%87'")
  })

  it('禁用的 query 参数不拼进 URL', () => {
    const spec = blank('https://api/x')
    spec.query.push({ key: 'a', value: '1', enabled: false })
    expect(generateCurl(spec)).toBe("curl 'https://api/x'")
  })

  it('空 key 的参数被忽略（UI 里未填完的行）', () => {
    const spec = blank('https://api/x')
    spec.query.push({ key: '', value: 'orphan', enabled: true })
    expect(generateCurl(spec)).toBe("curl 'https://api/x'")
  })
})

describe('body 输出', () => {
  it('json 自动补 Content-Type', () => {
    const spec = blank()
    spec.method = 'POST'
    spec.body.type = 'json'
    spec.body.json = '{"a":1}'
    expect(generateCurl(spec)).toContain("-H 'Content-Type: application/json'")
  })

  it('用户自己写了 Content-Type 就不越权覆盖', () => {
    const spec = blank()
    spec.method = 'POST'
    spec.headers.push({ key: 'Content-Type', value: 'application/geo+json', enabled: true })
    spec.body.type = 'json'
    spec.body.json = '{"a":1}'
    const out = generateCurl(spec)
    expect(out).toContain("'Content-Type: application/geo+json'")
    expect(out.match(/Content-Type/g)?.length).toBe(1)
  })

  it('空 json 既不补头也不输出 body', () => {
    const spec = blank()
    spec.body.type = 'json'
    spec.body.json = '   '
    expect(generateCurl(spec)).toBe("curl 'https://api.example.com/x'")
  })

  it('form 用 & 拼接并逐项编码', () => {
    const spec = blank()
    spec.method = 'POST'
    spec.body.type = 'form'
    spec.body.form = [
      { key: 'a', value: '1', enabled: true },
      { key: 'b', value: 'x y', enabled: true }
    ]
    expect(generateCurl(spec)).toContain("-d 'a=1&b=x%20y'")
  })

  it('raw 用 --data-binary（保留字节语义）', () => {
    const spec = blank()
    spec.method = 'POST'
    spec.body.type = 'raw'
    spec.body.raw = '<note>hi</note>'
    expect(generateCurl(spec)).toContain("--data-binary '<note>hi</note>'")
  })

  it('multipart 文件项输出 k=@path;filename=..;type=..', () => {
    const spec = blank()
    spec.method = 'POST'
    spec.body.type = 'multipart'
    spec.body.multipart = [
      { key: 'f', kind: 'file', value: '/tmp/a.png', filename: 'renamed.png', contentType: 'image/png', enabled: true }
    ]
    expect(generateCurl(spec)).toContain("-F 'f=@/tmp/a.png;filename=renamed.png;type=image/png'")
  })

  it('文本项含 ; @ < 时退回 --form-string（否则 curl 会把数据当指令解析）', () => {
    const spec = blank()
    spec.method = 'POST'
    spec.body.type = 'multipart'
    spec.body.multipart = [
      { key: 'a', kind: 'text', value: 'x;y', enabled: true },
      { key: 'b', kind: 'text', value: '@not-a-file', enabled: true },
      { key: 'c', kind: 'text', value: '<redirect', enabled: true },
      { key: 'd', kind: 'text', value: 'plain', enabled: true }
    ]
    const out = generateCurl(spec)
    expect(out).toContain("--form-string 'a=x;y'")
    expect(out).toContain("--form-string 'b=@not-a-file'")
    expect(out).toContain("--form-string 'c=<redirect'")
    expect(out).toContain("-F 'd=plain'")
  })
})

describe('auth 输出', () => {
  it('bearer 走 Authorization 头', () => {
    const spec = blank()
    spec.auth = { type: 'bearer', bearer: { token: 'TOK' }, basic: { username: '', password: '' } }
    expect(generateCurl(spec)).toContain("-H 'Authorization: Bearer TOK'")
  })

  it('basic 走 -u', () => {
    const spec = blank()
    spec.auth = { type: 'basic', basic: { username: 'bob', password: 'pw' }, bearer: { token: '' } }
    expect(generateCurl(spec)).toContain("-u 'bob:pw'")
  })

  it('auth 生效后，headers 里同名的 Authorization 不再重复输出（curl 会发两个认证头）', () => {
    const spec = blank()
    spec.headers.push({ key: 'Authorization', value: 'Bearer STALE', enabled: true })
    spec.auth = { type: 'bearer', bearer: { token: 'FRESH' }, basic: { username: '', password: '' } }
    const out = generateCurl(spec)
    expect(out).toContain('FRESH')
    expect(out).not.toContain('STALE')
    expect(out.match(/Authorization/g)?.length).toBe(1)
  })

  it('auth.type=none 时 Authorization 头照常输出（不被吞）', () => {
    const spec = blank()
    spec.headers.push({ key: 'Authorization', value: 'Bearer RAW', enabled: true })
    expect(generateCurl(spec)).toContain("-H 'Authorization: Bearer RAW'")
  })

  it('空 token / 空账号密码不产生任何输出', () => {
    const spec = blank()
    spec.auth = { type: 'bearer', bearer: { token: '' }, basic: { username: 'u', password: 'p' } }
    expect(generateCurl(spec)).toBe("curl 'https://api.example.com/x'")
  })
})

describe('选项映射', () => {
  it('timeoutMs 走 -m（总时限），connectTimeoutMs 走 --connect-timeout', () => {
    const spec = blank()
    spec.options.timeoutMs = 15000
    spec.options.connectTimeoutMs = 3000
    const out = generateCurl(spec)
    expect(out).toContain('-m 15')
    expect(out).toContain('--connect-timeout 3')
  })

  it('亚秒级超时保留小数', () => {
    const spec = blank()
    spec.options.timeoutMs = 1500
    expect(generateCurl(spec)).toContain('-m 1.5')
  })

  it('0 表示未设置，不输出时限', () => {
    const spec = blank()
    spec.options.timeoutMs = 0
    expect(generateCurl(spec)).not.toContain('-m')
  })

  it('-L / -k / --compressed / -A / -x 各归各位', () => {
    const spec = blank()
    spec.options.followRedirects = true
    spec.options.insecure = true
    spec.options.compressed = true
    spec.options.userAgent = 'curlviz/1'
    spec.options.proxy = 'http://127.0.0.1:8888'
    const lines = generateCurl(spec).split('\n').map((l) => l.trim().replace(/ \\$/, ''))
    expect(lines).toContain('-L')
    expect(lines).toContain('-k')
    expect(lines).toContain('--compressed')
    expect(lines).toContain("-A 'curlviz/1'")
    expect(lines).toContain("-x 'http://127.0.0.1:8888'")
  })

  it('no-location 不会被生成成 -L（只有显式 true 才输出）', () => {
    const spec = parseCurl("curl 'https://api/x' --no-location").spec
    expect(generateCurl(spec)).not.toContain('-L')
  })
})

describe('rawArgs 逃生通道', () => {
  it('原样追加在末尾，顺序保持', () => {
    const spec = blank()
    spec.rawArgs.push('--cacert ./ca.pem', '--retry 3')
    expect(generateCurl(spec)).toBe(
      "curl 'https://api.example.com/x' \\\n  --cacert ./ca.pem \\\n  --retry 3"
    )
  })
})
