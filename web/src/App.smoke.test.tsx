import { describe, expect, it } from 'vitest'
import { renderToString } from 'react-dom/server'
import { App } from './App'

/**
 * 冒烟测试：整棵组件树能不能渲染出来。
 *
 * 用 react-dom/server 而不是 jsdom —— 这里只想守住"打开就是白屏"这类事故
 * （导入路径写错、render 期就抛的 undefined 访问、hooks 顺序错了），
 * 不想为它多养一个 DOM 依赖。交互与副作用由 lib 里那些纯函数测试负责。
 */
describe('App 首屏', () => {
  it('渲染出不报错，四个区块都在', () => {
    const html = renderToString(<App />)
    expect(html).toContain('CurlViz')
    expect(html).toContain('<h2>请求</h2>')
    expect(html).toContain('粘贴 curl 导入')
    expect(html).toContain('<h2>响应</h2>')
    expect(html).toContain('只存这台机器')
  })

  it('首屏没有响应时给的是"还没发过"，不是崩或空白', () => {
    const html = renderToString(<App />)
    expect(html).toContain('还没发过')
  })

  it('引号与多行开关默认态可见（Windows 用户必须能找到切换入口）', () => {
    const html = renderToString(<App />)
    expect(html).toContain('多行')
    expect(html).toContain('Windows 引号')
  })

  it('没填 URL 时发送按钮禁用，并说明原因（不给一个点了没反应的按钮）', () => {
    const html = renderToString(<App />)
    expect(html).toContain('disabled')
    expect(html).toContain('填了 URL 才能发送')
  })

  it('M2 的三个新面板都在首屏里：集合库、导入导出、环境选择器', () => {
    const html = renderToString(<App />)
    // 空库状态也不能是一片空白，要告诉用户这东西怎么用
    expect(html).toContain('还没有存过请求')
    expect(html).toContain('＋新建集合')
    expect(html).toContain('导入 / 导出')
    expect(html).toContain('拖到这里')
    expect(html).toContain('不启用')
  })
})
