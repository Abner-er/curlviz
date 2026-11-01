import { describe, expect, it } from 'vitest'
import { ensureScheme, hasScheme } from './url-scheme'

describe('ensureScheme（失焦时给地址栏补协议，可编辑）', () => {
  it('空串不动（别把 https:// 塞进空框当吓人的默认值）', () => {
    expect(ensureScheme('')).toBe('')
    expect(ensureScheme('   ')).toBe('   ')
  })

  it('裸域名补 https://', () => {
    expect(ensureScheme('internal.api')).toBe('https://internal.api')
    expect(ensureScheme('internal.api/v1/list')).toBe('https://internal.api/v1/list')
  })

  it('localhost 带端口也补（curl 会当 host:port，缺协议 fetch 会拼成页面源）', () => {
    expect(ensureScheme('localhost:8080/x')).toBe('https://localhost:8080/x')
  })

  it('已经有协议的一律不越权改（含 http，用户手写的算数）', () => {
    for (const u of ['https://a.b', 'http://a.b', 'HTTP://a.b', 'ftp://a.b', 'ws://a.b']) {
      expect(ensureScheme(u)).toBe(u)
    }
  })

  it('相对协议 //host 只补 scheme，保留后面的 //', () => {
    expect(ensureScheme('//internal.api/v1')).toBe('https://internal.api/v1')
  })

  it('开头是 {{变量}} 不动（变量整段可能就是含协议的 base，猜协议会造出坏值）', () => {
    expect(ensureScheme('{{api_base}}/v1')).toBe('{{api_base}}/v1')
    expect(ensureScheme('{{host}}')).toBe('{{host}}')
  })

  it('默认协议可换成 http（同一函数复用，不为"要 http 的人"再写一套）', () => {
    expect(ensureScheme('internal.api', 'http')).toBe('http://internal.api')
  })

  it('补完去掉首尾空白（URL 里的空格本就非法）', () => {
    expect(ensureScheme('  internal.api  ')).toBe('https://internal.api')
  })
})

describe('hasScheme', () => {
  it('有协议为真，裸域名与相对协议为假', () => {
    expect(hasScheme('https://a.b')).toBe(true)
    expect(hasScheme('http://a.b')).toBe(true)
    expect(hasScheme('a.b')).toBe(false)
    expect(hasScheme('//a.b')).toBe(false)
  })
})
