import { describe, expect, it } from 'vitest'
import { renderToString } from 'react-dom/server'
import type { ParseWarning } from '@curlviz/core'
import { CurlPreview } from './CurlPreview'

/**
 * curl 预览 dock 的渲染（SSR，不引 jsdom）。
 *
 * 判定与文案都在 lib/fetch-rules + lib/display，那里有单测；组件这层只钉三件事：
 * 传了提醒就真画出来、并且和解析告警合进同一个列表（两个外观相同的 ul.notes 叠着像画重了）、
 * 以及"折起来只折正文，不折主动作与提醒"。
 */
const CURL = "curl -X POST 'https://api.example.com/v1/chat'\n  -H 'Content-Type: application/json'"

function render(props: {
  warnings?: ParseWarning[]
  preNotices?: string[]
  open?: boolean
  quoteStyle?: 'posix' | 'windows'
  multiline?: boolean
}): string {
  return renderToString(
    <CurlPreview
      curl={CURL}
      warnings={props.warnings ?? []}
      {...(props.preNotices !== undefined ? { preNotices: props.preNotices } : {})}
      quoteStyle={props.quoteStyle ?? 'posix'}
      multiline={props.multiline ?? true}
      onQuoteStyle={() => undefined}
      onMultiline={() => undefined}
      open={props.open ?? true}
      onToggle={() => undefined}
    />
  ).replaceAll('<!-- -->', '')
}

const NOTICES = ['到 https://api.example.com 是跨域，这条会被先打一个 OPTIONS 预检']

describe('curl 预览 dock 的发送前提醒', () => {
  it('传了 preNotices：提醒画在预览区里，用户不必先点一次发送才知道', () => {
    const html = render({ preNotices: NOTICES })
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

describe('curl 预览 dock 的折叠', () => {
  it('展开时画正文，标题带行数', () => {
    const html = render({ open: true })
    expect(html).toContain('<pre class="code">')
    expect(html).toContain('等价 curl（2 行）')
    expect(html).toContain('aria-expanded="true"')
  })

  it('折起来只折正文：命令本身不再占地方', () => {
    const html = render({ open: false })
    expect(html).not.toContain('<pre class="code">')
    expect(html).toContain('aria-expanded="false"')
  })

  it('折起来后「复制到终端」还在 —— 收起正文不该把主动作一起收走', () => {
    expect(render({ open: false })).toContain('复制到终端')
  })

  it('折起来时提醒不跟着消失，换成一颗能点开展开的计数胶囊', () => {
    const html = render({ open: false, preNotices: NOTICES, warnings: [{ code: 'malformed', message: '少个右引号' }] })
    expect(html).not.toContain('class="notes"')
    expect(html).toContain('2 条提醒')
    expect(html).toContain('class="chip warn"')
  })

  it(`没有提醒时折叠头上不该冒出"0 条提醒"这种空胶囊`, () => {
    expect(render({ open: false })).not.toContain('条提醒')
  })
})

describe('curl 预览 dock 的引号与多行开关', () => {
  it('引号风格做成两段控件，当前那份按下去是按下态', () => {
    const html = render({ quoteStyle: 'windows' })
    expect(html).toContain('aria-pressed="true"')
    // POSIX 那一段没按下：按下态只有一处（cmd.exe）
    expect(html.split('aria-pressed="true"').length - 1).toBe(1)
    expect(html).toContain('cmd.exe')
  })

  it('原来那颗"跑不通？切 Windows 引号"的补丁按钮不再画 —— 分段控件已经说明当前是哪份', () => {
    expect(render({ quoteStyle: 'posix' })).not.toContain('跑不通')
  })
})
