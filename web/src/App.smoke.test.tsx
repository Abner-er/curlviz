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

  it('M2 的三个新面板都在首屏里：集合库、导入导出、环境面板', () => {
    const html = renderToString(<App />)
    // 空库状态也不能是一片空白，要告诉用户这东西怎么用
    expect(html).toContain('还没有存过请求')
    expect(html).toContain('＋新建集合')
    expect(html).toContain('导入 / 导出')
    expect(html).toContain('拖到这里')
    expect(html).toContain('不启用')
  })
})

/**
 * 三栏 shell 是 UI 重排的结论本身，不是实现细节：
 * 布局一旦飘回"两栏 + 预览在右栏"，读命令要跨过整个响应区，
 * 而这条是最难在人工点验时发现退化的（看起来还是那个界面）。
 */
describe('三栏 shell', () => {
  it('资料库 / 工作台 / 结果三个区域各就各位', () => {
    const html = renderToString(<App />)
    expect(html).toContain('class="shell-lib"')
    expect(html).toContain('class="shell-work"')
    expect(html).toContain('class="shell-result"')
    expect(html).toContain('资料库')
  })

  it('curl 预览跟在工作台里、且在响应区之前（改一个参数要立刻看到命令怎么变）', () => {
    const html = renderToString(<App />)
    const work = html.indexOf('class="shell-work"')
    const result = html.indexOf('class="shell-result"')
    const preview = html.indexOf('等价 curl')
    const response = html.indexOf('<h2>响应</h2>')
    expect(work).toBeGreaterThan(-1)
    expect(preview).toBeGreaterThan(work)
    expect(preview).toBeLessThan(result)
    expect(response).toBeGreaterThan(result)
  })

  it('环境只有一个入口：顶栏那个重复选择器已经没了', () => {
    const html = renderToString(<App />)
    // 顶栏曾经有 title="切换当前环境变量集" 的 select，与左栏「当前环境」是同一件事的两个入口
    expect(html).not.toContain('切换当前环境变量集')
    expect(html).toContain('当前环境')
  })

  it('表单只剩五个页签，变量不再挤在里面（它属于资料库，不属于这条命令本身）', () => {
    const html = renderToString(<App />)
    // 只截页签那一小段来判：整页里"变量"这两个字还会出现（环境表格的列名），
    // 那是对的，不能被这条断言误伤
    const nav = /<nav class="tabs"[^>]*>[\s\S]*?<\/nav>/.exec(html)?.[0] ?? ''
    expect(nav).toContain('Query')
    expect(nav).toContain('选项')
    expect(nav).not.toContain('变量')
    expect(nav.match(/<button/g)?.length).toBe(5)
  })
})

/**
 * 页签的键盘可达性。
 *
 * 首屏 SSR 验得出"结构对不对"，验不出"按下方向键焦点去哪"（那归 lib/tabs 与 lib/focus 的算术测试）。
 * 这里钉的是最容易悄悄退化、又最难在人工点验里发现的一层：role 关系与 tabindex 分配。
 */
describe('页签的键盘可达性', () => {
  it('五个页签是一组 tablist，选中态只有一个', () => {
    const html = renderToString(<App />)
    expect(html).toContain('role="tablist"')
    expect(html.match(/role="tab"/g)?.length).toBe(5)
    expect(html.match(/aria-selected="true"/g)?.length).toBe(1)
    expect(html.match(/aria-selected="false"/g)?.length).toBe(4)
  })

  it('只有当前页签留在 Tab 顺序里（roving tabindex），其余交给方向键', () => {
    const nav = /<nav class="tabs"[^>]*>[\s\S]*?<\/nav>/.exec(renderToString(<App />))?.[0] ?? ''
    expect(nav.match(/tabindex="0"/g)?.length).toBe(1)
    expect(nav.match(/tabindex="-1"/g)?.length).toBe(4)
  })

  it('五个面板壳都在 DOM 上：aria-controls 指着的 id 不能只在选中时才存在', () => {
    const html = renderToString(<App />)
    expect(html.match(/role="tabpanel"/g)?.length).toBe(5)
    // 未选中的四个靠 hidden 收着，不是不渲染 —— 不渲染就成了悬空引用
    expect(html.match(/<div role="tabpanel"[^>]*hidden/g)?.length).toBe(4)
    for (const which of ['query', 'headers', 'body', 'auth', 'options']) {
      expect(html).toContain(`aria-controls="panel-${which}"`)
      expect(html).toContain(`id="panel-${which}"`)
    }
  })
})
