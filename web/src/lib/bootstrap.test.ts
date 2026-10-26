import { describe, expect, it } from 'vitest'
import { buildCollection, createDefaultSpec, redactSpec, type CurlSpec } from '@curlviz/core'
import { KEYS, createStore, memoryKeyValue } from './storage'
import { applySharePayload, hasShareHash, loadBootState } from './bootstrap'
import { NO_OPEN_REF } from './collections'
import { DEFAULT_ENV_NAME } from './environments'
import type { SharePayload } from './share'

function spec(url: string, name = 'req'): CurlSpec {
  const s = createDefaultSpec(name)
  s.url = url
  return s
}

describe('开机状态', () => {
  it('全新安装：一个默认环境是激活的，没有集合，也没有打开位置', () => {
    const boot = loadBootState(createStore(memoryKeyValue()))
    expect(boot.colState.collections).toEqual([])
    expect(boot.envState.activeName).toBe(DEFAULT_ENV_NAME)
    expect(boot.openRef).toEqual(NO_OPEN_REF)
    expect(boot.didMigrate).toBe(false)
    expect(boot.note).toBeNull()
  })

  it('M1 留下的扁平变量被并进默认环境，并说明迁了几个', () => {
    const store = createStore(memoryKeyValue())
    store.save(KEYS.vars, { gw: '10.0.0.9', token: 'abc' })
    const boot = loadBootState(store)
    expect(boot.didMigrate).toBe(true)
    expect(boot.envState.environments.find((e) => e.name === DEFAULT_ENV_NAME)?.variables.length).toBe(2)
    expect(boot.note).toContain('M1')
  })

  it('读不出集合数据不会把开机流程搞崩（返回空库而不是抛异常）', () => {
    const store = createStore(memoryKeyValue())
    store.save(KEYS.collections, { collections: [null, 42, { name: '  ', requests: 'nope' }, { name: 'ok', requests: [{ id: 'r', updatedAt: 1, spec: spec('https://a/b') }] }] })
    const boot = loadBootState(store)
    expect(boot.colState.collections.map((c) => c.name)).toEqual(['ok'])
  })

  it('存坏的历史 openRef 一律降级成"没打开任何条目"', () => {
    const store = createStore(memoryKeyValue())
    store.save(KEYS.collections, { collections: [{ id: 'col1', name: 'C', requests: [{ id: 'r1', updatedAt: 1, spec: spec('https://a/b') }] }] })
    store.save(KEYS.openRef, { collectionId: 'col1', requestId: '已经被删了' })
    expect(loadBootState(store).openRef).toEqual(NO_OPEN_REF)

    const still = createStore(memoryKeyValue())
    still.save(KEYS.collections, { collections: [{ id: 'col1', name: 'C', requests: [{ id: 'r1', updatedAt: 1, spec: spec('https://a/b') }] }] })
    still.save(KEYS.openRef, { collectionId: 'col1', requestId: 'r1' })
    expect(loadBootState(still).openRef).toEqual({ collectionId: 'col1', requestId: 'r1' })
  })
})

describe('分享载荷落到状态', () => {
  it('单请求：只换编辑器内容，不动集合', () => {
    const store = createStore(memoryKeyValue())
    const boot = loadBootState(store)
    const payload: SharePayload = { kind: 'request', spec: spec('https://shared/a'), redacted: true, at: 1 }
    const applied = applySharePayload(payload, boot.colState, boot.envState)
    expect(applied.spec?.url).toBe('https://shared/a')
    expect(applied.collectionId).toBeNull()
    expect(applied.warn).toBe(true)
    expect(applied.note).toContain('脱敏')
    expect(applied.colState).toBe(boot.colState)
  })

  it('集合：作为新集合入库，附带的环境并进来', () => {
    const boot = loadBootState(createStore(memoryKeyValue()))
    const collection = buildCollection([spec('https://shared/a'), spec('https://shared/b')], [
      { name: '分享来的环境', variables: [{ key: 'gw', value: '10.1.1.1', enabled: true }] }
    ])
    const payload: SharePayload = { kind: 'collection', collection, redacted: false, at: 1 }
    const applied = applySharePayload(payload, boot.colState, boot.envState)
    expect(applied.collectionId).not.toBeNull()
    expect(applied.colState.collections.length).toBe(1)
    expect(applied.colState.collections[0]?.requests.length).toBe(2)
    expect(applied.envState.environments.map((e) => e.name)).toContain('分享来的环境')
    expect(applied.warn).toBe(false)
    expect(applied.note).toContain('2 条')
  })

  it('脱敏过的集合要在提示里说清楚，别让人以为拿到就能发', () => {
    const boot = loadBootState(createStore(memoryKeyValue()))
    const collection = buildCollection([redactSpec(spec('https://shared/a'))])
    const applied = applySharePayload({ kind: 'collection', collection, redacted: true, at: 1 }, boot.colState, boot.envState)
    expect(applied.note).toContain('脱敏')
  })

  it('解开却不是请求也不是集合的载荷：如实报，不静默', () => {
    const boot = loadBootState(createStore(memoryKeyValue()))
    const applied = applySharePayload({ kind: 'request', redacted: false, at: 1 }, boot.colState, boot.envState)
    expect(applied.warn).toBe(true)
    expect(applied.spec).toBeNull()
    expect(applied.note).toContain('既没有请求也没有集合')
  })
})

describe('分享链接识别', () => {
  it('只认 #share=，别的 hash 不打扰导入流程', () => {
    expect(hasShareHash('#share=curlviz:1:pabc')).toBe(true)
    expect(hasShareHash('#top=1')).toBe(false)
    expect(hasShareHash(undefined)).toBe(false)
  })
})
