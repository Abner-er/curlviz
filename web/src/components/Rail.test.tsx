import { describe, expect, it } from 'vitest'
import { renderToString } from 'react-dom/server'
import { Rail, type RailAction } from './Rail'

/**
 * 左侧操作栏的渲染（SSR，不引 jsdom）。
 *
 * 这栏是"资料库抽屉默认关着"那个决定的补偿：入口必须常驻可见，
 * 所以钉三件事——七个动作一个都不能少、徽章要进可读名字、禁用项要说清楚。
 */
const ALL: RailAction[] = ['new', 'import', 'collections', 'env', 'io', 'history', 'share']

function render(
  props: {
    badges?: Partial<Record<RailAction, string>>
    disabled?: Partial<Record<RailAction, boolean>>
  } = {}
): string {
  return renderToString(<Rail onAction={() => undefined} {...props} />).replaceAll('<!-- -->', '')
}

describe('Rail', () => {
  it('七个动作全在，标签是两字中文（不用图标，也就没有"悬停才知道是什么"）', () => {
    const html = render()
    expect(html.split('class="rail-btn"').length - 1).toBe(ALL.length)
    for (const label of ['新建', '导入', '集合', '环境', '导出', '历史', '分享']) expect(html).toContain(label)
  })

  it('不靠 emoji 当图标', () => {
    expect(render()).not.toMatch(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u)
  })

  it('徽章数字进 aria-label，读屏念出来带得数量', () => {
    const html = render({ badges: { collections: '12', history: '3' } })
    expect(html).toContain('aria-label="集合（12）"')
    expect(html).toContain('aria-label="历史（3）"')
    expect(html).toContain('>12<')
  })

  it('没给徽章的项，aria-label 就是光秃秃的动作名（不冒出"undefined"）', () => {
    const html = render({ badges: { collections: '12' } })
    expect(html).toContain('aria-label="新建"')
    expect(html).not.toContain('undefined')
  })

  it('URL 没填时分享那颗禁用，别的一颗不受影响', () => {
    const html = render({ disabled: { share: true } })
    expect(html.split('disabled=""').length - 1).toBe(1)
    expect(html).toContain('aria-label="分享"')
  })
})
