import { describe, expect, it } from 'vitest'
import { renderToString } from 'react-dom/server'
import { ExecutorManager } from './ExecutorManager'
import { NO_EXECUTORS, type ExecutorRegistry } from '../lib/executors'

function render(
  registry: ExecutorRegistry,
  tokens: Record<string, string> = {}
): string {
  return renderToString(
    <ExecutorManager
      registry={registry}
      tokenOf={(id) => tokens[id] ?? ''}
      onAdd={() => undefined}
      onUpdate={() => undefined}
      onRemove={() => undefined}
      onSetToken={() => undefined}
    />
  )
}

describe('ExecutorManager 渲染（SSR，不引 jsdom）', () => {
  it('空注册表：计数 0、给空态引导，添加按钮禁用（名称/地址都空）', () => {
    const html = render(NO_EXECUTORS)
    expect(html).toContain('已登记')
    expect(html).toContain('还没有执行机')
    expect(html).toContain('disabled')
    expect(html).toContain('添加执行机')
  })

  it('有一台：卡标题显示机器名，token 未填时标签点出"未填"', () => {
    const reg: ExecutorRegistry = { executors: [{ id: 'a', name: 'ECS-1', baseUrl: 'https://a.internal' }], activeId: null }
    const html = render(reg)
    expect(html).toContain('ECS-1')
    expect(html).toContain('会话 token')
    expect(html).toContain('未填')
  })

  it('这台已填 token：标签不再显示"未填"', () => {
    const reg: ExecutorRegistry = { executors: [{ id: 'a', name: 'ECS-1', baseUrl: 'https://a.internal' }], activeId: null }
    const html = render(reg, { a: 'tk' })
    expect(html).not.toContain('未填')
  })
})
