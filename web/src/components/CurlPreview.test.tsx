import { describe, expect, it } from 'vitest'
import { renderToString } from 'react-dom/server'
import { CurlPreview } from './CurlPreview'

/**
 * curl 预览区的渲染（SSR，不引 jsdom）。
 *
 * 判定与文案都在 lib/fetch-rules + lib/display，那里有单测；组件这层只钉两件事：
 * 传了提醒就真画出来、并且和解析告警合进同一个列表（两个外观相同的 ul.notes 叠着像画重了）。
 */
function render(props: { warnings?: Parameters<typeof CurlPreview>[0]['warnings']; preNotices?: string[] }): string {
  return renderToString(
    <CurlPreview
      curl={'curl -X POST \'https://api.example.com/v1/chat\'\n  -H \'Content-Type: application\''}
      warnings={props.warnings ?? []}
      {...(props.preNotices !== undefined ? { preNotices: props.preNotices } : {})}
      quoteStyle="posix"
      onFixQuoteStyle={() => undefined}
    />
  ).replaceAll('<!-- -->', '')
}

describe('curl 预览区的发送前提醒', () => {
  it('传了 preNotices：提醒画在预览区里，用户不必先点一次发送才知道', () => {
    const html = render({ preNotices: ['到 https://api.example.com 是跨域，这条会被先打一个 OPTIONS 预检'] })
    expect(html).toContain('OPTIONS 预检')
    expect(html).toContain('class="notes"')
  })

  it('不传就一条都不画（同源命令不该常年挂着跨域提醒）', () => {
    expect(render({})).not.toContain('class="notes"')
  })

  it('告警与提醒同时存在时合进一个列表，而不是上下两个外观相同的列表', () => {
    const html = render({
      warnings: [{ code: 'unknown-flag', message: '--foo 未识别' }],
      preNotices: ['到 https://api.example.com 是跨域']
    })
    expect(html.split('class="notes"').length - 1).toBe(1)
    expect(html).toContain('--foo 未识别')
    expect(html).toContain('是跨域')
    // 两条各占一个 li：合并不等于吞掉
    expect(html.split('<li>').length - 1).toBe(2)
  })
})
