import { describe, expect, it } from 'vitest'
import { importCurlText, importErrorText } from './imports'

describe('importErrorText', () => {
  it('core 的解析错误只说 message，不重复挂"解析失败"两次前缀以外的东西', () => {
    expect(importErrorText(new Error('引号没闭合'))).toBe('解析失败：Error: 引号没闭合')
  })

  it('非 Error（字符串 / undefined 抛出来）也不能让提示函数自己崩', () => {
    expect(importErrorText('炸了')).toContain('解析失败：')
    expect(importErrorText(undefined)).toContain('解析失败：')
  })
})

describe('importCurlText', () => {
  it('正常命令：给出 spec 与 warnings，URL 落在位', () => {
    const r = importCurlText("curl 'https://api.example.com/v1/list' -H 'X-Trace: abc'")
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.spec.url).toBe('https://api.example.com/v1/list')
    expect(r.spec.headers.length).toBeGreaterThan(0)
    expect(Array.isArray(r.warnings)).toBe(true)
  })

  it('没名字的命令自动补一个来自 URL 的名字（否则集合库里全是"未命名请求"）', () => {
    const r = importCurlText("curl 'https://api.example.com/v1/orders'")
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.spec.name).not.toBe('未命名请求')
    expect(r.spec.name.trim()).not.toBe('')
  })

  it('空文本 / 不像 curl 的文本给一句能看懂的失败原因，不抛异常', () => {
    const r = importCurlText('随便一句话')
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error).toContain('解析失败')
  })

  it('返回的 spec 是新对象：改它不该碰到别的调用结果', () => {
    const a = importCurlText("curl 'https://api.example.com/x'")
    const b = importCurlText("curl 'https://api.example.com/x'")
    if (!a.ok || !b.ok) throw new Error('这两条都该解析成功')
    a.spec.url = 'https://改过的.example.com'
    expect(b.spec.url).toBe('https://api.example.com/x')
  })
})
