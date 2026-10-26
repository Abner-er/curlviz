import { describe, expect, it } from 'vitest'
import { renderToString } from 'react-dom/server'
import { createDefaultSpec } from '@curlviz/core'
import { addCollection, EMPTY_COLLECTION_STATE, NO_OPEN_REF, saveRequest, type CollectionState } from '../lib/collections'
import { emptyEnvs, type EnvState } from '../lib/environments'
import { LibraryPanel } from './LibraryPanel'

/**
 * 资料库抽屉的内容（SSR，不引 jsdom）。
 *
 * 为什么单独测这一层：抽屉改成按需打开之后，这三节在 App 首屏里已经不存在了
 * —— App.smoke 只能验到"顶栏那颗按钮"，验不到库里还有没有东西。
 * 而 Overlay 是 portal 到 body 的，服务端渲染器不认 portal，所以能测的正是
 * 被拆出来的这一块，不是外面那层壳。
 */

const LIBRARY: CollectionState = (() => {
  let st = addCollection(EMPTY_COLLECTION_STATE, '生产巡检').state
  st = saveRequest(st, st.collections[0]!.id, { ...createDefaultSpec('查订单'), url: 'https://api.example.com/x' }).state
  st = saveRequest(st, st.collections[0]!.id, { ...createDefaultSpec('重启服务'), url: 'https://ops.example.com/restart' }).state
  return st
})()

function render(colState: CollectionState = EMPTY_COLLECTION_STATE, envState: EnvState = emptyEnvs()): string {
  // 去掉 React 在相邻表达式之间写的 <!-- -->，理由同 App.smoke.test.tsx：
  // 断言里写的应当是人眼看到的那句
  return renderToString(
    <LibraryPanel
      colState={colState}
      envState={envState}
      activeRef={NO_OPEN_REF}
      currentSpec={createDefaultSpec('当前请求')}
      currentName="当前请求"
      defaultRedact
      onClose={() => undefined}
      onJump={() => undefined}
      onColState={() => undefined}
      onEnvState={() => undefined}
      onOpen={() => undefined}
      onSaved={() => undefined}
      onShare={() => undefined}
      onApplySpec={() => undefined}
      onImportCurl={() => null}
      onNotice={() => undefined}
    />
  ).replaceAll('<!-- -->', '')
}

describe('资料库抽屉的内容', () => {
  it('三节各有落点，顶部那一排跳转按钮才不是哑的', () => {
    const html = render()
    for (const id of ['lib-collections', 'lib-env', 'lib-io']) {
      expect(html).toContain(`id="${id}"`)
    }
    expect(html).toContain('aria-label="跳到资料库的某一节"')
    // 落点写在 markup 里，跳转按钮的 onClick 只负责把 id 递出去（id 名单见 LibrarySection）
    const nav = /<nav class="drawer-jump"[\s\S]*?<\/nav>/.exec(html)?.[0] ?? ''
    expect(nav.match(/<button/g)?.length).toBe(3)
  })

  it('空库不是一片空白：还是说清这地方怎么用', () => {
    const html = render()
    expect(html).toContain('还没有存过请求')
    expect(html).toContain('＋新建集合')
  })

  it('标题那行报的数量与实际一致（抽屉默认关着，这行是"库里有没有东西"的可见线索）', () => {
    expect(render()).toContain('0 集合 · 0 请求')
    expect(render(LIBRARY)).toContain('1 集合 · 2 请求')
  })

  it('环境面板在库里，且看得见当前生效的是哪一个', () => {
    const html = render()
    expect(html).toContain('当前环境')
    // 「不启用」这个选项必须存在：不替换变量是合法用法，不是没配好
    expect(html).toContain('不启用环境')
  })

  it('导入 / 导出在库里：备份、分享码、集合 JSON、curl 四岔路口都从这一格走', () => {
    const html = render()
    expect(html).toContain('导入 / 导出')
    expect(html).toContain('拖到这里')
    // 完整备份带明文凭据，这句话不能被布局改动挤掉
    expect(html).toContain('请按密码对待这个文件')
  })

  it('收起按钮在吸顶那一格里 —— 抽屉整高滚动，滚下去就找不到出口了', () => {
    const bar = /<div class="drawer-bar">[\s\S]*?<\/nav>/.exec(render())?.[0] ?? ''
    expect(bar).toContain('收起')
  })
})
