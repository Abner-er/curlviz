import { describe, expect, it } from 'vitest'
import { renderToString } from 'react-dom/server'
import type { CurlSpec, MultipartParam } from '@curlviz/core'
import { blankRequest } from '../lib/collections'
import { BodyEditor } from './Editors'

/**
 * multipart 这张表的草稿行（末行常驻空行）。
 *
 * 它**没有**复用 KeyValueTable —— 七列（发/字段/类型/值/filename/type/删）各自不同，
 * 所以那套"末行是草稿"的逻辑是照着再写一遍的。再写的东西最容易漏，故单独钉：
 * KeyValueTable 的 4 条测试覆盖不到这里。
 */
function renderBody(rows: MultipartParam[], type: CurlSpec['body']['type'] = 'multipart'): string {
  const spec: CurlSpec = { ...blankRequest(), body: { ...blankRequest().body, type, multipart: rows } }
  // 去掉 React 写在相邻表达式之间的 <!-- -->，理由同 App.smoke.test.tsx
  return renderToString(<BodyEditor spec={spec} onChange={() => undefined} />).replaceAll('<!-- -->', '')
}

const tbodyRows = (html: string): number => (/<tbody>[\s\S]*?<\/tbody>/.exec(html)?.[0].match(/<tr/g) ?? []).length
const delButtons = (html: string): number => html.split('title="删除"').length - 1

describe('multipart 表的末行草稿', () => {
  it('一条字段都没有时也给一行可打字的空行，且不画「＋ 添加一项」', () => {
    const html = renderBody([])
    expect(tbodyRows(html)).toBe(1)
    // 草稿行不是摆设：它带的就是那个字段名输入框
    expect(html).toContain('placeholder="file"')
    expect(html).not.toContain('添加一项')
    // 草稿行没有删除按钮：点了没东西可删，等于一个假装能按的键
    expect(delButtons(html)).toBe(0)
  })

  it('末行有内容 → 补一行草稿；已有空末行 → 不补第二行', () => {
    expect(tbodyRows(renderBody([{ key: 'file', kind: 'file', value: '/a.pdf', enabled: true }]))).toBe(2)
    expect(tbodyRows(renderBody([{ key: '', kind: 'text', value: '', enabled: true }]))).toBe(1)
  })

  it('只填了 filename、字段名为空的行：当下不再补草稿行，但它是真数据所以带 ✕', () => {
    // 判据只看 key/value（kv-rows.ts 的 Keyed），filename 是附带信息。
    // 代价登记在这里：这种半截行不会额外再长出空白行，补齐字段名后下一格才出现草稿行。
    const html = renderBody([{ key: '', kind: 'file', value: '', filename: 'x.pdf', enabled: true }])
    expect(tbodyRows(html)).toBe(1)
    expect(delButtons(html)).toBe(1)
  })

  it('其它 body 类型不受影响（none 时压根没有表）', () => {
    expect(renderBody([], 'none')).not.toContain('<table class="kv">')
  })
})
