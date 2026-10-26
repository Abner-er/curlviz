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
