import { describe, expect, it } from 'vitest'
import type { ResolveEntry } from '@curlviz/core'
import { applyResolveEdit, needsDraftResolveRow } from './resolve-rows'

const r = (host: string, port: number, addr: string): ResolveEntry => ({ host, port, addr })

describe('末行要不要补草稿行（三格）', () => {
  it('空表要补：一进来就该有一行能直接打字', () => {
    expect(needsDraftResolveRow([])).toBe(true)
  })

  it('末行三格全空（host、addr 皆空且端口 0）就不补', () => {
    expect(needsDraftResolveRow([r('a.test', 80, '10.0.0.1'), r('', 0, '')])).toBe(false)
  })

  it('末行有内容就补', () => {
    expect(needsDraftResolveRow([r('a.test', 80, '10.0.0.1')])).toBe(true)
  })

  it('只填了端口没填 host/addr 的末行算真数据：下面另起一格草稿', () => {
    expect(needsDraftResolveRow([r('', 8080, '')])).toBe(true)
  })

  it('host 填了、addr 还空的半截行算真数据', () => {
    expect(needsDraftResolveRow([r('a.test', 0, '')])).toBe(true)
  })
})

describe('编辑落行（越界即追加）', () => {
  const rows = [r('a.test', 80, '10.0.0.1')]

  it('落在真实行内：就地改该行，其余不动', () => {
    const out = applyResolveEdit(rows, 0, { host: 'b.test' })
    expect(out).toEqual([r('b.test', 80, '10.0.0.1')])
  })

  it('落在草稿位置（越界）：追加一行，未给的字段沿用空白草稿默认端口 0', () => {
    const out = applyResolveEdit(rows, 1, { host: 'c.test', addr: '::1' })
    expect(out).toEqual([r('a.test', 80, '10.0.0.1'), r('c.test', 0, '::1')])
  })
})
