import { describe, expect, it } from 'vitest'
import { renderToString } from 'react-dom/server'
import type { Param } from '@curlviz/core'
import { headerRowNote, queryRowNote } from '../lib/display'
import { KeyValueTable } from './KeyValueTable'

/**
 * 键值表的渲染（SSR，不引 jsdom）。
 *
 * 这里只钉一件事：**语义胶囊有没有真的画出来**。判定与文案都在 lib/display，
 * 那边有单测；组件这层的价值是"接上了、并且不传就不画"，
 * 因为 form / multipart 两张表共用同一个组件，误接会让它们也长出胶囊。
 */
const ROWS: Param[] = [
  { key: 'g', value: 'hello world', enabled: true, viaUrlQuery: true },
  { key: 'page', value: '1', enabled: true }
]

function render(props: { rows: Param[]; withNote: boolean }): string {
  // 去掉 React 写在相邻表达式之间的 <!-- -->，理由同 App.smoke.test.tsx
  return renderToString(
    <KeyValueTable
      rows={props.rows}
      onChange={() => undefined}
      keyPlaceholder="参数名"
      valuePlaceholder="值"
      {...(props.withNote ? { rowNote: queryRowNote } : {})}
    />
  ).replaceAll('<!-- -->', '')
}

describe('键值表的语义胶囊', () => {
  it('传了 rowNote：--url-query 那一行画出胶囊，普通行不画', () => {
    const html = render({ rows: ROWS, withNote: true })
    expect(html).toContain('class="tag-mini"')
    expect(html).toContain('--url-query')
    // 只该有一颗：第二行是折进 URL 的普通参数
    expect(html.split('tag-mini').length - 1).toBe(1)
  })

  it('胶囊带 title（语义只在 hover 里讲清，表格里只放两个字）', () => {
    expect(render({ rows: ROWS, withNote: true })).toContain('title="这一项来自 --url-query')
  })

  it('不传 rowNote 就一颗都不画 —— form / multipart 表不受影响', () => {
    expect(render({ rows: ROWS, withNote: false })).not.toContain('tag-mini')
  })

  it('headers 表：值为空的行标「删头」，有值的行不标', () => {
    const html = renderToString(
      <KeyValueTable
        rows={[
          { key: 'Accept', value: '', enabled: true },
          { key: 'X-Key', value: 'v', enabled: true }
        ]}
        onChange={() => undefined}
        keyPlaceholder="Header-Name"
        valuePlaceholder="值"
        rowNote={headerRowNote}
      />
    ).replaceAll('<!-- -->', '')
    expect(html).toContain('删头')
    expect(html.split('tag-mini').length - 1).toBe(1)
  })
})

/**
 * 末行那格草稿。
 *
 * 数 `<tr>` 要减掉表头那一行；数删除按钮用它的 title，比数 `class="mini"` 稳
 * （胶囊也是 tag-mini 字样，别拿形状当身份）。
 */
describe('末行的草稿行', () => {
  const body = (rows: Param[]): string =>
    renderToString(
      <KeyValueTable rows={rows} onChange={() => undefined} keyPlaceholder="参数名" valuePlaceholder="值" />
    ).replaceAll('<!-- -->', '')
  const rowCount = (html: string): number => html.split('<tr').length - 1 - 1
  const delCount = (html: string): number => html.split('title="删除这一行"').length - 1

  it('空表也有一行能直接打字，不必先点按钮', () => {
    const html = body([])
    expect(rowCount(html)).toBe(1)
    expect(html).toContain('placeholder="参数名"')
  })

  it('末行已经空着就不再补第二格空白', () => {
    expect(rowCount(body([{ key: 'a', value: '1', enabled: true }, { key: '', value: '', enabled: true }]))).toBe(2)
  })

  it('末行有内容时多出一格草稿，但那格不给删除按钮（它不在数据里）', () => {
    const html = body([
      { key: 'a', value: '1', enabled: true },
      { key: 'b', value: '2', enabled: true }
    ])
    expect(rowCount(html)).toBe(3)
    expect(delCount(html)).toBe(2)
  })

  it('「＋ 添加一行」那颗按钮整个不再出现', () => {
    const html = body([])
    expect(html).not.toContain('添加一行')
  })
})
