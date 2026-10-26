import { describe, expect, it } from 'vitest'
import {
  charsetOf,
  classifyBody,
  decodeBody,
  formatBytes,
  formatMs,
  MAX_PREVIEW_BYTES,
  prettyJson,
  truncateBytes
} from './response'

const enc = (s: string): Uint8Array => new TextEncoder().encode(s)

describe('charsetOf', () => {
  it('取声明的字符集，大小写与引号都认', () => {
    expect(charsetOf('text/plain; charset=GBK')).toBe('gbk')
    expect(charsetOf('application/json; charset="utf-8"')).toBe('utf-8')
    expect(charsetOf('text/html; Charset=UTF-8')).toBe('utf-8')
  })

  it('没声明就返回 null，别瞎猜', () => {
    expect(charsetOf('text/html')).toBeNull()
    expect(charsetOf('')).toBeNull()
  })
})

describe('decodeBody', () => {
  it('按声明的 GBK 解码（内网老系统常见）', () => {
    const gbk = new Uint8Array([0xd6, 0xd0, 0xce, 0xc4])
    expect(decodeBody(gbk, 'text/plain; charset=GBK')).toBe('中文')
  })

  it('声明了浏览器不认的编码时退回 UTF-8，不抛错', () => {
    expect(decodeBody(enc('ok'), 'text/plain; charset=x-made-up')).toBe('ok')
  })

  it('坏字节换成 U+FFFD，其余内容照样看得见', () => {
    const bad = new Uint8Array([0x61, 0xff, 0xfe, 0x62])
    const text = decodeBody(bad, 'text/plain')
    expect(text).toContain('a')
    expect(text).toContain('b')
    expect(text).toContain('\uFFFD')
  })
})

describe('classifyBody', () => {
  it('有 Content-Type 就照它归类', () => {
    expect(classifyBody('image/png', '', enc(''))).toBe('image')
    expect(classifyBody('application/pdf', '', enc(''))).toBe('pdf')
    expect(classifyBody('application/json; charset=utf-8', '{}', enc('{}'))).toBe('json')
    expect(classifyBody('text/html; charset=utf-8', '<p>hi', enc('<p>hi'))).toBe('html')
    expect(classifyBody('application/xml', '<a/>', enc('<a/>'))).toBe('xml')
    expect(classifyBody('text/plain', 'hi', enc('hi'))).toBe('text')
    expect(classifyBody('text/csv', 'a,b', enc('a,b'))).toBe('text')
    expect(classifyBody('application/javascript', 'x', enc('x'))).toBe('text')
    expect(classifyBody('application/zip', '', enc(''))).toBe('binary')
  })

  it('vendor JSON（application/vnd.api+json）也算 JSON', () => {
    expect(classifyBody('application/vnd.api+json', '{}', enc('{}'))).toBe('json')
  })

  it('类型缺失时兜底猜：像 JSON 就按 JSON，带 NUL 就按二进制', () => {
    expect(classifyBody('', '{"a":1}', enc('{"a":1}'))).toBe('json')
    expect(classifyBody('application/octet-stream', '[1,2]', enc('[1,2]'))).toBe('json')
    expect(classifyBody('', '<!DOCTYPE html><html></html>', enc('<!DOCTYPE html><html></html>'))).toBe('html')
    expect(classifyBody('', 'hello', enc('hello'))).toBe('text')
    expect(classifyBody('', '', new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00]))).toBe('binary')
    // 以 { 开头但解析不过：只是碰巧，不能当 JSON 渲染
    expect(classifyBody('', '{ 这不是 JSON', enc('{ 这不是 JSON'))).toBe('text')
  })
})

describe('truncateBytes', () => {
  it('没超上限原样返回', () => {
    const bytes = enc('short')
    const r = truncateBytes(bytes, null)
    expect(r.truncated).toBe(false)
    expect(r.totalBytes).toBe(bytes.length)
    expect(r.bytes).toBe(bytes)
  })

  it('超上限只留前 max 字节并标 truncated', () => {
    const big = new Uint8Array(MAX_PREVIEW_BYTES + 10)
    const r = truncateBytes(big, null, MAX_PREVIEW_BYTES)
    expect(r.truncated).toBe(true)
    expect(r.bytes.length).toBe(MAX_PREVIEW_BYTES)
    expect(r.totalBytes).toBe(big.length)
  })

  it('Content-Length 比实收字节大（断流后）时按服务端口径报总量', () => {
    const r = truncateBytes(new Uint8Array(100), 999_999)
    expect(r.truncated).toBe(false)
    expect(r.totalBytes).toBe(999_999)
  })
})

describe('formatBytes / formatMs', () => {
  it('字节数人类可读', () => {
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(1024)).toBe('1.0 KB')
    expect(formatBytes(102_400)).toBe('100 KB')
    expect(formatBytes(MAX_PREVIEW_BYTES)).toBe('512 KB')
    expect(formatBytes(1024 * 1024)).toBe('1.0 MB')
    expect(formatBytes(3 * 1024 * 1024 * 1024)).toBe('3.0 GB')
  })

  it('毫秒小于 1 秒用 ms，否则用 s', () => {
    expect(formatMs(12.3)).toBe('12 ms')
    expect(formatMs(1000)).toBe('1.00 s')
    expect(formatMs(1234)).toBe('1.23 s')
  })
})

describe('prettyJson', () => {
  it('两空格缩进', () => {
    expect(prettyJson('{"a":1,"b":[2]}')).toBe('{\n  "a": 1,\n  "b": [\n    2\n  ]\n}')
  })

  it('带 BOM 也能解析（Java 后端常见）', () => {
    expect(prettyJson('\uFEFF{"a":1}')).toBe('{\n  "a": 1\n}')
  })

  it('坏了就原样返回，不把正文换成报错', () => {
    expect(prettyJson('not json')).toBe('not json')
  })
})
