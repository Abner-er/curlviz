import { describe, expect, it } from 'vitest'
import {
  addExecutor,
  buildTransport,
  NO_EXECUTORS,
  removeExecutor,
  sanitizeRegistry,
  setActive,
  updateExecutor,
  type ExecutorRegistry
} from './executors'

function reg(executors: ExecutorRegistry['executors'], activeId: string | null = null): ExecutorRegistry {
  return { executors, activeId }
}

describe('sanitizeRegistry：脏数据收敛成能用的注册表', () => {
  it('合法条目留下，缺字段的丢掉', () => {
    const out = sanitizeRegistry({
      executors: [
        { id: 'a', name: 'ECS-1', baseUrl: 'https://a.internal' },
        { id: 'b', name: '', baseUrl: 'https://b.internal' },
        { id: 'c', name: 'C', baseUrl: '  ' },
        { id: '', name: 'D', baseUrl: 'https://d.internal' },
        { name: '无 id', baseUrl: 'https://e' }
      ],
      activeId: 'a'
    })
    expect(out.executors.map((e) => e.id)).toEqual(['a'])
    expect(out.activeId).toBe('a')
  })

  it('重复 id 只留第一条；activeId 悬空回落成浏览器', () => {
    const out = sanitizeRegistry({
      executors: [
        { id: 'a', name: '一', baseUrl: 'https://a1' },
        { id: 'a', name: '二', baseUrl: 'https://a2' }
      ],
      activeId: 'ghost'
    })
    expect(out.executors).toHaveLength(1)
    expect(out.executors[0]?.name).toBe('一')
    expect(out.activeId).toBeNull()
  })

  it('非对象 / 缺 executors → 空注册表', () => {
    expect(sanitizeRegistry(null)).toEqual(NO_EXECUTORS)
    expect(sanitizeRegistry('str')).toEqual(NO_EXECUTORS)
    expect(sanitizeRegistry({ executors: 'nope' })).toEqual({ executors: [], activeId: null })
  })
})

describe('增删改', () => {
  it('addExecutor：追加并回传新建那条（供调用方塞 token），顺带 trim', () => {
    const { registry, executor } = addExecutor(NO_EXECUTORS, { name: '  ECS-1  ', baseUrl: ' https://a ' }, 'fixed-id')
    expect(executor).toEqual({ id: 'fixed-id', name: 'ECS-1', baseUrl: 'https://a' })
    expect(registry.executors).toEqual([executor])
  })

  it('updateExecutor：改 name/baseUrl，id 不动；未知 id 原样返回', () => {
    const base = reg([{ id: 'a', name: '旧', baseUrl: 'https://old' }], 'a')
    const out = updateExecutor(base, 'a', { name: '新名' })
    expect(out.executors[0]).toEqual({ id: 'a', name: '新名', baseUrl: 'https://old' })
    expect(updateExecutor(base, 'zzz', { name: 'x' })).toEqual(base)
  })

  it('removeExecutor：删当前选中项时 activeId 回落浏览器；删非选中项保留 activeId', () => {
    const base = reg(
      [
        { id: 'a', name: 'A', baseUrl: 'https://a' },
        { id: 'b', name: 'B', baseUrl: 'https://b' }
      ],
      'a'
    )
    const removedActive = removeExecutor(base, 'a')
    expect(removedActive.executors.map((e) => e.id)).toEqual(['b'])
    expect(removedActive.activeId).toBeNull()
    expect(removeExecutor(base, 'b').activeId).toBe('a')
  })

  it('setActive：认得的 id 才设；未知 id 与 null 都回落浏览器', () => {
    const base = reg([{ id: 'a', name: 'A', baseUrl: 'https://a' }])
    expect(setActive(base, 'a').activeId).toBe('a')
    expect(setActive(base, 'ghost').activeId).toBeNull()
    expect(setActive(reg(base.executors, 'a'), null).activeId).toBeNull()
  })
})

describe('buildTransport：注册表 + 会话 token → TransportSelector', () => {
  const base = reg([{ id: 'a', name: 'ECS-1', baseUrl: 'https://a.internal' }], 'a')

  it('没选中 → 浏览器', () => {
    expect(buildTransport({ ...base, activeId: null }, { a: 'tk' })).toEqual({ kind: 'browser' })
  })

  it('选中且会话里有 token → agent 带 token', () => {
    expect(buildTransport(base, { a: 'tk-1' })).toEqual({
      kind: 'agent',
      executor: { id: 'a', name: 'ECS-1', baseUrl: 'https://a.internal', token: 'tk-1' }
    })
  })

  it('选中但会话里没 token（刷新后）→ agent 且 token 空串（不编造，让 agent 如实拒）', () => {
    const t = buildTransport(base, {})
    if (t.kind !== 'agent') throw new Error('本该是 agent')
    expect(t.executor.token).toBe('')
  })

  it('悬空选择（activeId 指向已不存在的执行机）→ 兜底浏览器', () => {
    expect(buildTransport({ executors: base.executors, activeId: 'ghost' }, { ghost: 'tk' })).toEqual({ kind: 'browser' })
  })
})
