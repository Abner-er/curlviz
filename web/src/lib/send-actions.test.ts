import { describe, expect, it } from 'vitest'
import { buildSendMenu, sendBadge } from './send-actions'

/**
 * 「发送 ▾」里该有什么。这一层判的是"这份命令粘到那个终端能不能直接跑"，
 * 判错的后果是用户粘了一份坏命令，所以措辞与出现条件都钉住。
 */
describe('buildSendMenu 的项', () => {
  it('默认（POSIX + 多行 + 无跨域风险）给四项，第一条就是当前风格的复制', () => {
    const m = buildSendMenu({ quoteStyle: 'posix', multiline: true, corsBlocked: false })
    expect(m.items.map((i) => i.id)).toEqual(['copy-terminal', 'copy-alt-quote', 'copy-single-line', 'copy-url'])
    expect(m.note).toBeNull()
    expect(m.items[0]?.label).toContain('POSIX 单引号')
  })

  it('已经是单行了就不给「复制为单行命令」—— 点了没反应的项比少一项更容易被当成 bug', () => {
    const m = buildSendMenu({ quoteStyle: 'posix', multiline: false, corsBlocked: false })
    expect(m.items.map((i) => i.id)).toEqual(['copy-terminal', 'copy-alt-quote', 'copy-url'])
  })

  it('当前风格是 cmd.exe 时，第一项跟着换成 cmd，备选变成 POSIX', () => {
    const m = buildSendMenu({ quoteStyle: 'windows', multiline: true, corsBlocked: false })
    expect(m.items[0]?.label).toContain('Windows 双引号')
    expect(m.items[1]?.label).toContain('POSIX 单引号')
  })

  it('每一项都自带"粘到哪儿能用"那句 hint（引号风格这东西不看一眼终端类型是分不出来）', () => {
    for (const item of buildSendMenu({ quoteStyle: 'posix', multiline: true, corsBlocked: true }).items) {
      expect(item.hint.length).toBeGreaterThan(0)
    }
  })

  it('跨域风险成立时顶部多一句说明，且它不是一种"点了会复制"的项', () => {
    const m = buildSendMenu({ quoteStyle: 'posix', multiline: true, corsBlocked: true })
    expect(m.note).toContain('OPTIONS 预检')
    expect(m.note).toContain('不是命令写错了')
    expect(m.items.some((i) => i.id === 'copy-terminal')).toBe(true)
  })
})

describe('sendBadge', () => {
  it('要发预检时给徽标文案', () => {
    expect(sendBadge(true)).toBe('可能被预检拦')
  })

  it('措辞是"可能"：预检要不要发能算，对方答不答应算不出来，徽标不能替对方表态', () => {
    expect(sendBadge(true)).not.toContain('一定')
    expect(sendBadge(true)).not.toMatch(/^被拦/)
  })

  it('不需要预检时是空串（组件按空串决定画不画）', () => {
    expect(sendBadge(false)).toBe('')
  })
})
