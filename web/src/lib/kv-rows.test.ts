import { describe, expect, it } from 'vitest'
import type { MultipartParam, Param } from '@curlviz/core'
import { applyRowEdit, needsDraftRow } from './kv-rows'

const p = (key: string, value = '', enabled = true): Param => ({ key, value, enabled })

describe('末行要不要补草稿行', () => {
  it('空表要补：一进来就该有一行能直接打字', () => {
    expect(needsDraftRow([])).toBe(true)
  })

  it('末行 key 与 value 都空就不补（那行本身已经是草稿）', () => {
    expect(needsDraftRow([p('a', '1'), p('')])).toBe(false)
  })

  it('末行有内容就补', () => {
    expect(needsDraftRow([p('a', '1')])).toBe(true)
  })

  it('只有 key 没有 value 的末行算有内容：headers 里那是 `-H K:` 删头，是真数据', () => {
    expect(needsDraftRow([p('Accept', '')])).toBe(true)
  })

  it('只有 value 没有 key 的末行也算有内容（用户可能先打字到值那一格）', () => {
    expect(needsDraftRow([p('', 'v')])).toBe(true)
  })

  it('只看末行：中间夹着的空行是用户自己留的，不该因此少一行草稿', () => {
    expect(needsDraftRow([p(''), p('a', '1')])).toBe(true)
  })
})

describe('编辑落到哪一行', () => {
  const BLANK: Param = { key: '', value: '', enabled: true }

  it('界内是就地改，长度不变、其它行不动', () => {
    const rows = [p('a', '1'), p('b', '2')]
    expect(applyRowEdit(rows, 1, BLANK, { value: '9' })).toEqual([p('a', '1'), p('b', '9')])
  })

  it('界外（= 草稿行）是追加，并且带着 blank 的默认字段', () => {
    const rows = [p('a', '1')]
    expect(applyRowEdit(rows, 1, BLANK, { key: 'b' })).toEqual([p('a', '1'), p('b', '')])
    // enabled 来自 BLANK 而不是 patch：勾着"发"的默认值不该因为打字而丢
    expect(applyRowEdit(rows, 1, BLANK, { key: 'b' })[1]?.enabled).toBe(true)
  })

  it('multipart 的 kind 也走同一条路：追加的行不会是个没类型的行', () => {
    const blank: MultipartParam = { key: '', kind: 'text', value: '', enabled: true }
    const rows: MultipartParam[] = []
    const next = applyRowEdit(rows, 0, blank, { value: 'v' })
    expect(next[0]).toEqual({ key: '', kind: 'text', value: 'v', enabled: true })
  })

  it('不改入参：BLANK 是模块级共享常量，被就地写一次就会污染整张表', () => {
    const rows = [p('a', '1')]
    applyRowEdit(rows, 0, BLANK, { key: 'zz' })
    applyRowEdit(rows, 1, BLANK, { key: 'new' })
    expect(rows).toEqual([p('a', '1')])
    expect(BLANK).toEqual({ key: '', value: '', enabled: true })
  })
})
