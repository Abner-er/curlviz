import { describe, expect, it } from 'vitest'
import type { ResolveEntry } from '@curlviz/core'
import { applyResolveEdit, needsDraftResolveRow, urlAuthority } from './resolve-rows'

const r = (host: string, port: number, addr: string): ResolveEntry => ({ host, port, addr })

describe('末行要不要补草稿行（只看 IP：addr 是提交触发）', () => {
  it('空表要补：一进来就该有一行能直接敲 IP', () => {
    expect(needsDraftResolveRow([])).toBe(true)
  })

  it('末行还没填 IP（addr 空）就不补：那行本身就是正在填的草稿', () => {
    expect(needsDraftResolveRow([r('a.test', 80, '10.0.0.1'), r('b.test', 443, '')])).toBe(false)
  })

  it('末行填了 IP 就补：这行成了真数据，下面另起一格', () => {
    expect(needsDraftResolveRow([r('a.test', 80, '10.0.0.1')])).toBe(true)
  })

  it('host/端口已从 URL 打底、但 IP 还空的半截行不再补草稿', () => {
    // 新面板常态：新行 host/端口预填，用户还没敲 IP 时不该无限长行
    expect(needsDraftResolveRow([r('a.test', 443, '')])).toBe(false)
  })
})

describe('编辑落行（越界即追加，追加用 seed 打底）', () => {
  const rows = [r('a.test', 80, '10.0.0.1')]

  it('落在真实行内：就地改该行，其余不动', () => {
    const out = applyResolveEdit(rows, 0, { host: 'b.test' })
    expect(out).toEqual([r('b.test', 80, '10.0.0.1')])
  })

  it('落在草稿位置（越界）：用 seed 打底追加，patch 覆盖到的字段生效', () => {
    const seed = r('c.test', 8443, '')
    const out = applyResolveEdit(rows, 1, { addr: '::1' }, seed)
    expect(out).toEqual([r('a.test', 80, '10.0.0.1'), r('c.test', 8443, '::1')])
  })

  it('不给 seed：沿用空白草稿默认（host 空、端口 0）', () => {
    const out = applyResolveEdit(rows, 1, { host: 'd.test', addr: '10.0.0.2' })
    expect(out).toEqual([r('a.test', 80, '10.0.0.1'), r('d.test', 0, '10.0.0.2')])
  })
})

describe('urlAuthority：从 URL 取域名+端口给新行打底', () => {
  it('https 无显式端口 → 443', () => {
    expect(urlAuthority('https://yunying.418lab.top')).toEqual({ host: 'yunying.418lab.top', port: 443 })
  })

  it('http 无显式端口 → 80', () => {
    expect(urlAuthority('http://a.test/x')).toEqual({ host: 'a.test', port: 80 })
  })

  it('显式端口优先于 scheme 默认', () => {
    expect(urlAuthority('https://a.test:8443/p')).toEqual({ host: 'a.test', port: 8443 })
  })

  it('空串 / 解析不动（含占位符）→ host 空、端口兜 443', () => {
    expect(urlAuthority('')).toEqual({ host: '', port: 443 })
    expect(urlAuthority('https://{{host}}/')).toEqual({ host: '', port: 443 })
  })
})
