import { describe, expect, it } from 'vitest'
import { renderToString } from 'react-dom/server'
import { createDefaultSpec, type CurlSpec } from '@curlviz/core'
import { addCollection, EMPTY_COLLECTION_STATE, NO_OPEN_REF, saveRequest, type CollectionState } from '../lib/collections'
import { CollectionsPanel } from './CollectionsPanel'

/**
 * 集合库面板的首屏冒烟（SSR，不引 jsdom）。
 *
 * 过滤、命中哪几条这些真逻辑在 lib/collections 的 searchLibrary 里已经逐条测过；
 * 这里只钉两件在组件里最容易悄悄改掉的事：搜索框什么时候出现、列表会不会把值摊上屏。
 */

function specWith(name: string, extra: Partial<CurlSpec>): CurlSpec {
  return { ...createDefaultSpec(name), url: 'https://api.example.com/x', ...extra }
}

const LIBRARY: CollectionState = (() => {
  let st = addCollection(EMPTY_COLLECTION_STATE, '生产巡检').state
  st = saveRequest(st, st.collections[0]!.id, specWith('查订单', {})).state
  st = saveRequest(
    st,
    st.collections[0]!.id,
    specWith('重启服务', {
      url: 'https://ops.example.com/restart',
      headers: [{ key: 'X-Trace', value: 'supertoken-abc', enabled: true }]
    })
  ).state
  return st
})()

const EMPTY = EMPTY_COLLECTION_STATE

function render(state: CollectionState): string {
  return renderToString(
    <CollectionsPanel
      state={state}
      environments={[]}
      currentSpec={createDefaultSpec('当前请求')}
      activeRef={NO_OPEN_REF}
      defaultRedact
      onStateChange={() => undefined}
      onOpen={() => undefined}
      onSaved={() => undefined}
      onShare={() => undefined}
      onNotice={() => undefined}
    />
  )
}

describe('集合库首屏', () => {
  it('空库不给搜索框 —— 没东西可搜时放个输入框只会让人以为库是坏的', () => {
    const html = render(EMPTY)
    expect(html).not.toContain('搜索集合库')
    expect(html).toContain('还没有存过请求')
  })

  it('一旦有集合就出现搜索框，且当场写清搜的是哪些字段', () => {
    const html = render(LIBRARY)
    expect(html).toContain('aria-label="搜索集合库"')
    expect(html).toContain('头名')
    expect(html).toContain('参数名')
  })

  it('空查询就是全量列表：两条请求、集合名、方法 URL 都在', () => {
    const html = render(LIBRARY)
    expect(html).toContain('查订单')
    expect(html).toContain('重启服务')
    expect(html).toContain('生产巡检')
    expect(html).toContain('https://ops.example.com/restart')
  })

  it('列表不摊明文凭据：请求行的标题里带 URL，但不带头值', () => {
    const html = render(LIBRARY)
    // 值只在点开那条之后才进编辑器 —— 左栏是给人扫读的，不是给人抄 token 的
    expect(html).not.toContain('supertoken-abc')
  })
})
