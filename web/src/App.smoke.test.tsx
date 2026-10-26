import { describe, expect, it } from 'vitest'
import { renderToString } from 'react-dom/server'
import { DEFAULT_ENV_NAME } from './lib/environments'
import { App } from './App'

/**
 * 首屏渲染出的文字。
 *
 * React 的服务端渲染会在两个相邻表达式之间写一个 `<!-- -->`（给 hydration 标边界），
 * 于是 `{n} 集合 · {m} 请求` 在 markup 里是 `0<!-- --> 集合 · <!-- -->0<!-- --> 请求`。
 * 人看见的文字里没有那玩意儿，所以按文案断言之前先去掉 —— 留下的就是人能读到的东西。
 */
function firstPaint(): string {
  return renderToString(<App />).replaceAll('<!-- -->', '')
}

/**
 * 冒烟测试：整棵组件树能不能渲染出来。
 *
 * 用 react-dom/server 而不是 jsdom —— 这里只想守住"打开就是白屏"这类事故
 * （导入路径写错、render 期就抛的 undefined 访问、hooks 顺序错了），
 * 不想为它多养一个 DOM 依赖。交互与副作用由 lib 里那些纯函数测试负责。
 */
describe('App 首屏', () => {
  it('渲染出不报错，四个区块都在', () => {
    const html = firstPaint()
    expect(html).toContain('CurlViz')
    expect(html).toContain('<h2>请求</h2>')
    expect(html).toContain('粘贴 curl 导入')
    expect(html).toContain('<h2>响应</h2>')
    expect(html).toContain('只存这台机器')
  })

  it('首屏没有响应时给的是"还没发过"，不是崩或空白', () => {
    const html = firstPaint()
    expect(html).toContain('还没发过')
  })

  it('引号与多行开关默认态可见（Windows 用户必须能找到切换入口）', () => {
    const html = firstPaint()
    expect(html).toContain('多行')
    expect(html).toContain('Windows 引号')
  })

  it('没填 URL 时发送按钮禁用，并说明原因（不给一个点了没反应的按钮）', () => {
    const html = firstPaint()
    expect(html).toContain('disabled')
    expect(html).toContain('填了 URL 才能发送')
  })

  it('首屏不开抽屉：库的内容不在这儿，但顶栏要看得见"有没有库、现在哪个环境"', () => {
    const html = firstPaint()
    // 抽屉与两个弹窗都是 portal 到 body 的，服务端渲染器不认 portal：
    // 它们出现在首屏渲染里就是白屏事故，所以这条 not 比 toContain 更要紧
    expect(html).not.toContain('role="dialog"')
    expect(html).not.toContain('class="drawer"')
    // 按钮标签首屏就有（那是入口），框本身不该有：这条钉的是"打开才挂载"
    expect(html).not.toContain('aria-label="curl 命令原文"')
    // 库收起来之后，"这里有个库、库里有多少东西"只剩这一处可见线索
    expect(html).toContain('资料库')
    expect(html).toContain('0 集合 · 0 请求')
    // 环境读数在顶栏。开机默认就是那个初始环境，不是"未启用"——
    // 未启用是用户手动选了「不启用环境」之后的状态
    expect(html).toContain(`环境 · ${DEFAULT_ENV_NAME}`)
    expect(html).not.toContain('切换当前环境变量集')
    // 「不启用环境」这一档只有抽屉里的环境面板会写：首屏出现它，就说明库没收进抽屉
    expect(html).not.toContain('不启用环境')
  })
})

/**
 * 两栏 shell + 右侧抽屉是这一轮界面结论本身，不是实现细节：
 * 布局一旦飘回"资料库占住左边一整列"，工作区就没了一整页宽度，
 * 而这类退化看着仍是同一个界面，人工点验最容易放过去。
 */
describe('两栏 shell 与资料库抽屉', () => {
  it('左栏不再占位：工作台 / 结果两栏，资料库那一列不许回来', () => {
    const html = firstPaint()
    expect(html).not.toContain('class="shell-lib"')
    expect(html).toContain('class="shell-work"')
    expect(html).toContain('class="shell-result"')
    // 库还在，只是换成了顶栏叫出来的抽屉
    expect(html).toContain('资料库')
  })

  it('curl 预览跟在工作台里、且在响应区之前（改一个参数要立刻看到命令怎么变）', () => {
    const html = firstPaint()
    const work = html.indexOf('class="shell-work"')
    const result = html.indexOf('class="shell-result"')
    const preview = html.indexOf('等价 curl')
    const response = html.indexOf('<h2>响应</h2>')
    expect(work).toBeGreaterThan(-1)
    expect(preview).toBeGreaterThan(work)
    expect(preview).toBeLessThan(result)
    expect(response).toBeGreaterThan(result)
  })

  it('顶栏的环境那颗只是读数：它不是下拉框，改动入口只有抽屉里那一处', () => {
    const html = firstPaint()
    // 顶栏曾有 title="切换当前环境变量集" 的 select，与库里的「当前环境」是同一件事的两个入口
    expect(html).not.toContain('切换当前环境变量集')
    expect(html).toContain('<button class="env-chip"')
    // 面板里那一格在抽屉后头，首屏不该出现（内容本身归 LibraryPanel.test 测）。
    // 判据不能用「当前环境」四个字：顶栏那颗的 title 就叫"当前环境：xxx"，那是对的
    expect(html).not.toContain('不启用环境')
    expect(html).not.toContain('分层规则')
  })

  it('表单只剩五个页签，变量不再挤在里面（它属于资料库，不属于这条命令本身）', () => {
    const html = firstPaint()
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
    const html = firstPaint()
    expect(html).toContain('role="tablist"')
    expect(html.match(/role="tab"/g)?.length).toBe(5)
    expect(html.match(/aria-selected="true"/g)?.length).toBe(1)
    expect(html.match(/aria-selected="false"/g)?.length).toBe(4)
  })

  it('只有当前页签留在 Tab 顺序里（roving tabindex），其余交给方向键', () => {
    const nav = /<nav class="tabs"[^>]*>[\s\S]*?<\/nav>/.exec(firstPaint())?.[0] ?? ''
    expect(nav.match(/tabindex="0"/g)?.length).toBe(1)
    expect(nav.match(/tabindex="-1"/g)?.length).toBe(4)
  })

  it('五个面板壳都在 DOM 上：aria-controls 指着的 id 不能只在选中时才存在', () => {
    const html = firstPaint()
    expect(html.match(/role="tabpanel"/g)?.length).toBe(5)
    // 未选中的四个靠 hidden 收着，不是不渲染 —— 不渲染就成了悬空引用
    expect(html.match(/<div role="tabpanel"[^>]*hidden/g)?.length).toBe(4)
    for (const which of ['query', 'headers', 'body', 'auth', 'options']) {
      expect(html).toContain(`aria-controls="panel-${which}"`)
      expect(html).toContain(`id="panel-${which}"`)
    }
  })
})
