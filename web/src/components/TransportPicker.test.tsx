import { describe, expect, it } from 'vitest'
import { renderToString } from 'react-dom/server'
import { TransportPicker, type TransportOption } from './TransportPicker'

const OPTS: TransportOption[] = [
  { id: 'a', name: 'ECS-1', hasToken: true },
  { id: 'b', name: 'ECS-2', hasToken: false }
]

function render(props: Partial<Parameters<typeof TransportPicker>[0]> = {}): string {
  return renderToString(
    <TransportPicker
      activeId={null}
      options={OPTS}
      onSelect={() => undefined}
      onManage={() => undefined}
      {...props}
    />
  )
}

describe('TransportPicker 渲染（SSR，不引 jsdom）', () => {
  it('没选中执行机 → 芯片显示"浏览器"，且不带 warn', () => {
    const html = render()
    expect(html).toContain('浏览器')
    expect(html).not.toContain('transport-btn" class="chip warn')
    expect(html).toContain('chip transport-btn')
  })

  it('选中一台且这台已填 token → 芯片显示机器名，不加 warn', () => {
    const html = render({ activeId: 'a' })
    expect(html).toContain('ECS-1')
    expect(html).not.toContain('chip warn')
  })

  it('选中一台但这台还没填 token → 芯片套 warn，提醒"发送会被拒"', () => {
    const html = render({ activeId: 'b' })
    expect(html).toContain('chip warn transport-btn')
    expect(html).toContain('ECS-2')
    expect(html).toContain('发送会被拒')
  })

  it('菜单是点开才画的，收起态不占 DOM', () => {
    expect(render()).not.toContain('role="menu"')
  })
})
