import { describe, expect, it } from 'vitest'
import { renderToString } from 'react-dom/server'
import { KNOWN_METHODS } from '@curlviz/core'
import { RequestBar } from './RequestBar'
import { buildSendMenu } from '../lib/send-actions'

/**
 * 请求行的渲染（SSR，不引 jsdom）。
 *
 * 钉的是这轮布局改动的几个关键事实：方法控件只剩一个、发送是分裂按钮、
 * 预检徽标只在判定成立时出现。菜单内容本身在 lib/send-actions 测。
 */
function render(props: Partial<Parameters<typeof RequestBar>[0]> = {}): string {
  const base: Parameters<typeof RequestBar>[0] = {
    name: 'orders-list',
    method: 'POST',
    url: 'https://internal.api/v1/orders',
    sending: false,
    canSend: true,
    preflightExpected: false,
    preflightReason: '',
    menu: buildSendMenu({ quoteStyle: 'posix', multiline: true, corsBlocked: false }),
    boundNote: null,
    onName: () => undefined,
    onMethod: () => undefined,
    onUrl: () => undefined,
    onSend: () => undefined,
    onCancel: () => undefined,
    onAction: () => undefined
  }
  return renderToString(<RequestBar {...base} {...props} />).replaceAll('<!-- -->', '')
}

describe('方法控件', () => {
  it('只有一个方法输入位（改之前是"下拉 + 一个重复的文本框"，白吃 352px）', () => {
    expect(render().split('class="method"').length - 1).toBe(1)
  })

  it('候选方法挂在 datalist 上，同时还能直接输入 PROPFIND 这类动词', () => {
    const html = render({ method: 'PROPFIND' })
    expect(html).toContain('value="PROPFIND"')
    for (const m of ['GET', 'POST', 'PUT', 'DELETE']) expect(html).toContain(`value="${m}"`)
    expect(html.split('</option>').length - 1).toBe(KNOWN_METHODS.length)
  })

  it('URL 框与方法框在同一行，URL 是那个可伸缩的', () => {
    const html = render()
    expect(html).toContain('class="url grow"')
    expect(html).toContain('req-bar')
  })
})

describe('发送分裂按钮', () => {
  it('主按钮是发送，旁边那颗 ▾ 带 menu 语义，菜单默认不画', () => {
    const html = render()
    expect(html).toContain('>发送<')
    expect(html).toContain('aria-haspopup="menu"')
    expect(html).toContain('aria-expanded="false"')
    expect(html).not.toContain('role="menu"')
  })

  it('发送中时主按钮变「取消」并换 danger 皮肤（这时点它是停止，不是再发一次）', () => {
    const html = render({ sending: true })
    expect(html).toContain('class="primary danger"')
    expect(html).toContain('>取消<')
    expect(html).not.toContain('>发送<')
  })

  it('URL 没填时主按钮禁用，▾ 仍可用（复制命令不需要能发出去）', () => {
    const html = render({ canSend: false })
    expect(html).toContain('class="primary" disabled')
    expect(html).toContain('填了 URL 才能发送')
    expect(html.split('aria-haspopup="menu"').length - 1).toBe(1)
  })
})

describe('预检徽标', () => {
  it('判定为要发预检时点亮，悬停给的是同一条判定文案', () => {
    const html = render({ preflightExpected: true, preflightReason: '到 https://a.b 是跨域，会先打一个 OPTIONS 预检' })
    expect(html).toContain('可能被预检拦')
    expect(html).toContain('title="到 https://a.b 是跨域')
  })

  it('同源或简单请求不画徽标（常年挂着一个"可能被拦"就等于没人再看它）', () => {
    expect(render()).not.toContain('class="chip warn"')
  })

  it('编辑自集合时那句话说在标题行里', () => {
    expect(render({ boundNote: '编辑自「内网」的 订单列表' })).toContain('编辑自「内网」的 订单列表')
  })
})

/**
 * 样式表里排在下面的 `button.caret { background: transparent }`（集合树的展开箭头）
 * 与 `button.primary { background: var(--accent) }` 同权重，于是这颗 ▾ 曾经底色被刮掉、字色还留着 ——
 * 实测对比度浅色 1.00 / 深色 1.08，一颗看不见的按钮。
 * CSS 层叠在这里测不出来（不引 jsdom），只能把"不许再叫 caret"钉在类名上。
 */
describe('分裂按钮那颗 ▾', () => {
  it('类名是 send-caret：叫 caret 会被集合树那条规则刮掉主按钮底色', () => {
    const caret = /<button[^>]*aria-label="复制与发送选项"[^>]*>/.exec(render({}))?.[0] ?? ''
    expect(caret).toContain('primary')
    expect(caret).toContain('send-caret')
    expect(caret).not.toContain('"primary caret"')
  })
})
