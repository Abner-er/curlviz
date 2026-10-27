import { describe, expect, it } from 'vitest'
import { createDefaultSpec, type CurlSpec, type Param } from '@curlviz/core'
import {
  currentPageHref,
  extOf,
  headerRowNote,
  historySummary,
  prefersReducedMotion,
  preSendNotices,
  queryRowNote,
  scrollBehaviorFor,
  suggestName,
  usedVars
} from './display'
import type { HistoryEntry } from '../types'

function entry(result?: HistoryEntry['result']): HistoryEntry {
  const spec: CurlSpec = createDefaultSpec('e')
  return { id: '1', at: 1_700_000_000_000, spec, redacted: false, result }
}

describe('usedVars', () => {
  it('url / header / query / body / auth / options 里写的变量都扫得到', () => {
    const spec: CurlSpec = createDefaultSpec('v')
    spec.url = 'https://{{gw}}/api'
    spec.query = [{ key: 'token', value: '{{qtok}}', enabled: true }]
    spec.headers = [{ key: 'X-Key', value: '{{hdr}}', enabled: true }]
    spec.body = { ...spec.body, type: 'json', json: '{"t":"{{jt}}"}' }
    spec.auth = { type: 'bearer', basic: { username: '{{u}}', password: '{{p}}' }, bearer: { token: '{{tok}}' } }
    spec.options = { ...spec.options, userAgent: '{{ua}}', proxy: '{{px}}' }
    expect(usedVars(spec)).toEqual(['gw', 'hdr', 'jt', 'p', 'px', 'qtok', 'tok', 'u', 'ua'])
  })

  it('逃生通道 rawArgs 里的变量也算：没说出口不等于不需要赋值', () => {
    const spec: CurlSpec = createDefaultSpec('r')
    spec.rawArgs = ['--resolve', '{{host}}:443:10.0.0.1']
    expect(usedVars(spec)).toEqual(['host'])
  })

  it('重名去重、结果稳定排序（面板不会每敲一下换顺序）', () => {
    const spec: CurlSpec = createDefaultSpec('d')
    spec.url = '{{a}}/{{b}}'
    spec.headers = [{ key: 'X', value: '{{a}}', enabled: true }]
    expect(usedVars(spec)).toEqual(['a', 'b'])
    expect(usedVars(spec)).toEqual(usedVars(spec))
  })

  it('没用变量就是空数组', () => {
    expect(usedVars(createDefaultSpec('n'))).toEqual([])
  })
})

describe('extOf / suggestName', () => {
  it('按 Content-Type 给后缀，认不出来用 .bin', () => {
    expect(extOf('application/json; charset=utf-8')).toBe('.json')
    expect(extOf('text/html')).toBe('.html')
    expect(extOf('application/xml')).toBe('.xml')
    expect(extOf('text/plain')).toBe('.txt')
    expect(extOf('image/png')).toBe('.png')
    expect(extOf('image/jpeg')).toBe('.jpg')
    expect(extOf('image/webp')).toBe('.img')
    expect(extOf('application/pdf')).toBe('.pdf')
    expect(extOf('application/octet-stream')).toBe('.bin')
    expect(extOf('')).toBe('.bin')
  })

  it('下载名带发送时间戳且不含冒号点号（Windows 文件名不允许）', () => {
    const name = suggestName(new Date('2026-10-26T09:36:14.500Z').getTime(), 'application/json')
    expect(name).toBe('curlviz-2026-10-26T09-36-14.json')
    expect(name).not.toMatch(/[:.](?!json)/)
  })
})

describe('historySummary', () => {
  it('没发过就说没发过', () => {
    expect(historySummary(entry())).toBe('未发送')
  })

  it('成功：状态码 + 耗时，一秒以内用 ms', () => {
    expect(historySummary(entry({ status: 200, ok: true, ms: 42 }))).toBe('200 · 42ms')
    expect(historySummary(entry({ status: 502, ok: false, ms: 1234 }))).toBe('502 · 1.23s')
  })

  it('失败：直接显示失败原因（历史列表不展开响应体，避免泄密）', () => {
    expect(historySummary(entry({ error: '请求没能完成' }))).toBe('请求没能完成')
  })
})

describe('跳转滚动该不该平滑', () => {
  it('勾了"减少动态效果"就立刻到位，没勾才滑过去', () => {
    expect(scrollBehaviorFor(true)).toBe('auto')
    expect(scrollBehaviorFor(false)).toBe('smooth')
  })

  it('读不到 matchMedia 时当没勾，而不是抛错', () => {
    // 这条测的正是"测试环境里没有 window"这个事实：抽屉的跳转 effect 要调它，
    // 它一抛错，那三颗跳转按钮就变成点了没反应的那种最难发现的坏
    expect(prefersReducedMotion()).toBe(false)
  })
})

describe('preSendNotices：发送前的提醒', () => {
  function specWithUrl(url: string): CurlSpec {
    return { ...createDefaultSpec('n'), url, method: 'POST', headers: [{ key: 'Content-Type', value: 'application/json', enabled: true }] }
  }

  it('URL 里写着 {{host}} 时，变量得先替换再判 origin —— 否则这条最该提醒的命令会被判成"没风险"', () => {
    const spec = specWithUrl('{{host}}/v1/chat/completions')
    const withVar = preSendNotices(spec, { host: 'https://api.example.com' }, 'http://localhost:5183/')
    expect(withVar).toHaveLength(1)
    expect(withVar[0]).toContain('https://api.example.com')
    expect(withVar[0]).toContain('Content-Type: application/json')
  })

  it('变量没赋值时 URL 还没成形：判不出来就沉默，不凭空提醒', () => {
    expect(preSendNotices(specWithUrl('{{host}}/v1/chat'), {}, 'http://localhost:5183/')).toEqual([])
  })

  it('同源不给提醒；页面地址取不到（node 测试环境 / SSR）也不给', () => {
    expect(preSendNotices(specWithUrl('http://localhost:5183/v1/chat'), {}, 'http://localhost:5183/')).toEqual([])
    expect(preSendNotices(specWithUrl('https://api.example.com/v1/chat'), {}, '')).toEqual([])
  })

  it('currentPageHref：没有 location 就返回空串，不抛错', () => {
    expect(currentPageHref()).toBe('')
  })
})

describe('表格某一行的语义胶囊', () => {
  const p = (o: Partial<Param>): Param => ({ key: 'k', value: 'v', enabled: true, ...o })

  it('query 里 --url-query 来的行标出来，折进 URL 的行不标', () => {
    expect(queryRowNote(p({ viaUrlQuery: true }))?.text).toBe('--url-query')
    expect(queryRowNote(p({}))).toBeNull()
    expect(queryRowNote(p({ viaUrlQuery: false }))).toBeNull()
    // 不标就等于骗人：这两类复制出去时走的是两条不同通道（编码表也不同）
    expect(queryRowNote(p({ viaUrlQuery: true }))?.title).toContain('不折进 URL')
  })

  it('headers 里值为空的行标「删头」，有值或没勾的都不标', () => {
    expect(headerRowNote(p({ value: '' }))?.text).toBe('删头')
    expect(headerRowNote(p({ value: 'x' }))).toBeNull()
    expect(headerRowNote(p({ value: '', enabled: false }))).toBeNull()
    expect(headerRowNote(p({ key: '', value: '' }))).toBeNull()
    // 文案里必须带着实测那句"不是发空值头"，这是用户最容易误解的一点
    expect(headerRowNote(p({ value: '' }))?.title).toContain('不是发一个空值头')
  })
})
