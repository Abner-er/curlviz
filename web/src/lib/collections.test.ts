import { describe, expect, it } from 'vitest'
import { createDefaultSpec, hasSensitive, type CurlSpec } from '@curlviz/core'
import {
  addCollection,
  blankRequest,
  coerceCollection,
  duplicateRequest,
  EMPTY_COLLECTION_STATE,
  environmentsFrom,
  findRequest,
  locateRequest,
  mergeImported,
  moveRequest,
  parseCollectionText,
  removeCollection,
  removeRequest,
  renameCollection,
  requestCount,
  saveRequest,
  sanitizeCollectionState,
  sanitizeOpenRef,
  searchLibrary,
  NO_OPEN_REF,
  toCollectionFile,
  toRequestFile,
  uniqueCollectionName,
  type CollectionState,
  type StoredCollection
} from './collections'

function spec(name: string, url = 'https://api.example.com/x'): CurlSpec {
  const s = createDefaultSpec(name)
  s.url = url
  return s
}

function stateWith(...cols: StoredCollection[]): CollectionState {
  return { collections: cols }
}

describe('集合级操作', () => {
  it('新建集合给的是可用的空库', () => {
    const { state, id } = addCollection(EMPTY_COLLECTION_STATE, '订单服务')
    expect(state.collections).toHaveLength(1)
    expect(state.collections[0]?.name).toBe('订单服务')
    expect(state.collections[0]?.requests).toEqual([])
    expect(id).toBeTruthy()
  })

  it('重名加序号，不覆盖也不静默合并', () => {
    let { state } = addCollection(EMPTY_COLLECTION_STATE, '生产')
    state = addCollection(state, '生产').state
    state = addCollection(state, '生产').state
    expect(state.collections.map((c) => c.name)).toEqual(['生产', '生产 (2)', '生产 (3)'])
  })

  it('空名字不至于留下一个看不见的集合', () => {
    expect(uniqueCollectionName(EMPTY_COLLECTION_STATE, '   ')).toBe('未命名集合')
  })

  it('改名会 trim；全空的名字不改，避免列表里出现空白项', () => {
    const { state, id } = addCollection(EMPTY_COLLECTION_STATE, 'a')
    expect(renameCollection(state, id, '  内网网关  ').collections[0]?.name).toBe('内网网关')
    expect(renameCollection(state, id, '   ').collections[0]?.name).toBe('a')
  })

  it('删集合只动自己，别人的请求不受牵连', () => {
    const a = addCollection(EMPTY_COLLECTION_STATE, 'a')
    const b = addCollection(a.state, 'b')
    const saved = saveRequest(b.state, b.id, spec('留在 b'))
    const after = removeCollection(saved.state, a.id)
    expect(after.collections.map((c) => c.name)).toEqual(['b'])
    expect(after.collections[0]?.requests).toHaveLength(1)
  })
})

describe('请求级操作', () => {
  const seed = () => {
    const col = addCollection(EMPTY_COLLECTION_STATE, '服务')
    const first = saveRequest(col.state, col.id, spec('一'))
    const second = saveRequest(first.state, col.id, spec('二'))
    return { colId: col.id, firstId: first.id, secondId: second.id, state: second.state }
  }

  it('新保存追加一条并返回 created=true；同一 id 再存是覆盖', () => {
    const { colId, firstId, state } = seed()
    const again = saveRequest(state, colId, spec('一改二', 'https://a/2'), firstId)
    expect(again.created).toBe(false)
    expect(again.id).toBe(firstId)
    const stored = findRequest(again.state, colId, firstId)
    expect(stored?.spec.name).toBe('一改二')
    expect(stored?.spec.url).toBe('https://a/2')
    expect(again.state.collections[0]?.requests).toHaveLength(2)
  })

  it('存进不存在的集合就原样返回，不凭空造集合', () => {
    const { state } = seed()
    const r = saveRequest(state, '没有这个集合', spec('幽灵'))
    expect(r.state).toBe(state)
    expect(r.created).toBe(false)
  })

  it('入库前补齐字段：残缺 spec 也存成完整形状', () => {
    const { colId, state } = seed()
    const partial = { url: 'https://only/url' } as unknown as CurlSpec
    const saved = saveRequest(state, colId, partial)
    const stored = findRequest(saved.state, colId, saved.id)
    expect(stored?.spec.options).toBeDefined()
    expect(stored?.spec.body.type).toBe('none')
    expect(stored?.spec.version).toBe(1)
  })

  it('复制紧跟在原条目后面，名字带"副本"', () => {
    const { colId, firstId, state } = seed()
    const r = duplicateRequest(state, colId, firstId)
    const names = r.state.collections[0]?.requests.map((x) => x.spec.name)
    expect(names).toEqual(['一', '一 副本', '二'])
  })

  it('跨集合移动；集合或请求找不到时不动任何数据', () => {
    const { colId, firstId, state } = seed()
    const other = addCollection(state, '另一个')
    const moved = moveRequest(other.state, colId, firstId, other.id)
    expect(requestCount(moved)).toBe(2)
    expect(moved.collections.find((c) => c.id === colId)?.requests.map((r) => r.spec.name)).toEqual(['二'])
    expect(locateRequest(moved, firstId)?.spec.name).toBe('一')

    expect(moveRequest(other.state, colId, firstId, '不存在')).toBe(other.state)
    expect(moveRequest(other.state, colId, '不存在的请求', other.id)).toBe(other.state)
    expect(moveRequest(other.state, colId, firstId, colId)).toBe(other.state)
  })

  it('删除请求只删一条', () => {
    const { colId, firstId, state } = seed()
    const after = removeRequest(state, colId, firstId)
    expect(after.collections[0]?.requests.map((r) => r.spec.name)).toEqual(['二'])
  })
})

describe('导出 / 导入', () => {
  const build = () => {
    const col = addCollection(EMPTY_COLLECTION_STATE, '支付')
    const withAuth: CurlSpec = { ...spec('带凭据'), auth: { type: 'basic', basic: { username: 'ops', password: 'p@ss' }, bearer: { token: '' } } }
    const a = saveRequest(col.state, col.id, withAuth)
    const b = saveRequest(a.state, col.id, spec('普通', 'https://pay/x'))
    return b.state.collections[0] as StoredCollection
  }

  it('导出默认脱敏：文件里搜不到密码', () => {
    const text = toCollectionFile(build(), true)
    expect(text).toContain('curlviz-collection')
    expect(text).not.toContain('p@ss')
    expect(text).toContain('https://pay/x')
  })

  it('不脱敏时凭据保留（用户自己备份用），并能在导入时被识别出来', () => {
    const raw = toCollectionFile(build(), false)
    expect(raw).toContain('p@ss')
    const parsed = parseCollectionText(raw)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.collection.requests.filter((r) => hasSensitive(r))).toHaveLength(1)
  })

  it('导出单条请求也是合法集合文件', () => {
    const parsed = parseCollectionText(toRequestFile(spec('一条', 'https://solo/y'), false))
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.collection.requests.map((r) => r.url)).toEqual(['https://solo/y'])
  })

  it('坏 JSON 给的是原因，不是崩', () => {
    expect(parseCollectionText('{ 不是 JSON').ok).toBe(false)
    expect(parseCollectionText('{}').ok).toBe(false)
    const err = parseCollectionText('{}')
    if (err.ok) return
    expect(err.error.length).toBeGreaterThan(0)
  })

  it('导入作为新集合入库，id 全部换新的（不会跟本库撞号）', () => {
    const existing = build()
    const state = stateWith(existing)
    const incoming = parseCollectionText(toCollectionFile(existing, false))
    if (!incoming.ok) throw new Error('导出坏了')
    const merged = mergeImported(state, incoming.collection, '支付 副本')
    expect(merged.state.collections).toHaveLength(2)
    const idsOld = state.collections[0]!.requests.map((r) => r.id)
    const idsNew = merged.state.collections[1]!.requests.map((r) => r.id)
    expect(idsNew.every((id) => !idsOld.includes(id))).toBe(true)
    expect(merged.skipped).toBe(0)
  })

  it('集合文件里的 environments 单独取出来，别混进请求库', () => {
    const collection = parseCollectionText(
      JSON.stringify({
        format: 'curlviz-collection',
        version: 1,
        environments: [{ name: '内网', variables: [{ key: 'gw', value: '10.0.0.1', enabled: true }] }],
        requests: [{ url: 'https://a' }]
      })
    )
    if (!collection.ok) throw new Error('解析坏了')
    expect(environmentsFrom(collection.collection)[0]?.name).toBe('内网')
    expect(collection.collection.requests).toHaveLength(1)
  })

  it('兜底能吃下裸 spec 数组和单个 spec', () => {
    expect(coerceCollection([{ url: 'https://a' }, { url: 'https://b' }])?.requests).toHaveLength(2)
    expect(coerceCollection({ url: 'https://only', method: 'POST' })?.requests).toHaveLength(1)
    // 集合对象有自己的路（parseCollection），这里不该误判
    expect(coerceCollection({ format: 'curlviz-collection', requests: [] })).toBeNull()
    expect(coerceCollection('字符串')).toBeNull()
    expect(coerceCollection([{ noUrl: 1 }])).toBeNull()
  })
})

describe('blankRequest', () => {
  it('是个能直接编辑的空基线，不带上一次的值', () => {
    const s = blankRequest()
    expect(s.url).toBe('')
    expect(s.name).toBe('未命名请求')
    expect(s.rawArgs).toEqual([])
  })
})

describe('sanitizeCollectionState（读坏数据不能把界面搞崩）', () => {
  it('认不出的条目丢掉；空白名 + 空内容才算坏数据，有名但请求全坏的保留成空集合', () => {
    const state = sanitizeCollectionState({
      collections: [
        null,
        42,
        '字符串',
        { name: '好', requests: [{ id: 'r1', updatedAt: 5, spec: { url: 'https://a/b', headers: [{ key: 'A', value: 'b' }] } }] },
        { name: '   ', requests: [{ id: 'r2', updatedAt: 1, spec: { url: 'https://c/d' } }] },
        { name: '   ', requests: [] },
        { name: '空壳', requests: [] },
        { name: '全是坏请求', requests: [{ spec: { url: '   ' } }, { spec: 7 }] },
        { id: 'dup', name: '好', requests: [] }
      ]
    })
    // 重名的两个"好"都留下：库里的集合按 id 区分，不该因为名字撞车就扔掉用户的东西
    expect(state.collections.map((c) => c.name)).toEqual(['好', '未命名集合', '空壳', '全是坏请求', '好'])
    const kept = state.collections[0]
    expect(kept?.requests[0]?.id).toBe('r1')
    expect(kept?.requests[0]?.spec.method).toBe('GET')
    expect(kept?.requests[0]?.spec.query).toEqual([])
    expect(state.collections[3]?.requests).toEqual([])
  })

  it('集合 id 与请求 id 原样保留（openRef 记的就是它们），只补缺失的', () => {
    const state = sanitizeCollectionState({
      collections: [{ id: 'col_keep', name: 'A', requests: [{ id: 'req_keep', updatedAt: 1, spec: { url: 'https://a' } }, { updatedAt: 1, spec: { url: 'https://b' } }] }]
    })
    expect(state.collections[0]?.id).toBe('col_keep')
    expect(state.collections[0]?.requests[0]?.id).toBe('req_keep')
    expect(state.collections[0]?.requests[1]?.id).toMatch(/^req_/)
  })

  it('整个对象不是 CollectionState 形状时当作空库', () => {
    expect(sanitizeCollectionState(undefined).collections).toEqual([])
    expect(sanitizeCollectionState([]).collections).toEqual([])
    expect(sanitizeCollectionState({ collections: 'nope' }).collections).toEqual([])
  })
})

describe('sanitizeOpenRef', () => {
  const state = sanitizeCollectionState({
    collections: [{ id: 'c1', name: 'A', requests: [{ id: 'r1', updatedAt: 1, spec: { url: 'https://a' } }] }]
  })

  it('指向的东西还在就原样保留', () => {
    expect(sanitizeOpenRef({ collectionId: 'c1', requestId: 'r1' }, state)).toEqual({ collectionId: 'c1', requestId: 'r1' })
  })

  it('集合或请求被删过、字段缺失、类型不对 → 一律降级成没打开任何条目', () => {
    expect(sanitizeOpenRef({ collectionId: 'c1', requestId: '被删了' }, state)).toEqual(NO_OPEN_REF)
    expect(sanitizeOpenRef({ collectionId: '不存在的集合', requestId: 'r1' }, state)).toEqual(NO_OPEN_REF)
    expect(sanitizeOpenRef({ collectionId: 'c1' }, state)).toEqual(NO_OPEN_REF)
    expect(sanitizeOpenRef({ collectionId: 1, requestId: 2 }, state)).toEqual(NO_OPEN_REF)
    expect(sanitizeOpenRef(null, state)).toEqual(NO_OPEN_REF)
  })
})

describe('searchLibrary', () => {
  const withHeaders = (name: string, url: string, headers: CurlSpec['headers']): CurlSpec => {
    const s = spec(name, url)
    s.headers = headers
    return s
  }

  const build = (): CollectionState => {
    let st = addCollection(addCollection(EMPTY_COLLECTION_STATE, '生产巡检').state, '测试环境').state
    const prod = st.collections[0]!
    const test = st.collections[1]!
    st = saveRequest(st, prod.id, spec('查订单', 'https://api.example.com/orders')).state
    st = saveRequest(
      st,
      prod.id,
      withHeaders('重启服务', 'https://ops.example.com/restart', [
        { key: 'X-Trace', value: 'abc', enabled: true },
        { key: 'X-Disabled', value: 'nope', enabled: false }
      ])
    ).state
    st = saveRequest(st, test.id, spec('拉指标', 'https://test.example.com/metrics')).state
    return st
  }

  const lib = build()

  it('空查询 = 不过滤，全部集合与全部请求都回来（面板只走一条渲染路径）', () => {
    const hits = searchLibrary(lib, '')
    expect(hits).toHaveLength(2)
    expect(hits[0]!.requests).toHaveLength(2)
    expect(hits[1]!.requests).toHaveLength(1)
    expect(hits.every((h) => !h.nameHit)).toBe(true)
  })

  it('集合名命中就把整块带出来，并标 nameHit 让界面展开', () => {
    const hits = searchLibrary(lib, '生产')
    expect(hits).toHaveLength(1)
    expect(hits[0]!.nameHit).toBe(true)
    expect(hits[0]!.requests).toHaveLength(2)
  })

  it('按请求名 / URL / 方法 / 头名命中；不相关的集合整个消失', () => {
    expect(searchLibrary(lib, '订单')[0]!.requests).toHaveLength(1)
    expect(searchLibrary(lib, 'metrics')[0]!.collection.name).toBe('测试环境')
    expect(searchLibrary(lib, 'post').length + searchLibrary(lib, 'get').length).toBe(2)
    expect(searchLibrary(lib, 'x-trace')[0]!.requests.map((r) => r.spec.name)).toEqual(['重启服务'])
    expect(searchLibrary(lib, '不存在的关键字')).toEqual([])
  })

  it('大小写不敏感，前后空格忽略', () => {
    expect(searchLibrary(lib, '  ORDERS  ')).toHaveLength(1)
    expect(searchLibrary(lib, 'X-TRACE')).toHaveLength(1)
    expect(searchLibrary(lib, '   ')).toHaveLength(2) // 只剩空格等于没搜
  })

  it('禁用状态的头名不参与搜索', () => {
    expect(searchLibrary(lib, 'x-disabled')).toEqual([])
  })

  it('不搜值：值里的字符串命中不了（免得把 token 之类显示在命中列表上）', () => {
    expect(searchLibrary(lib, 'abc')).toEqual([])
    expect(searchLibrary(lib, 'nope')).toEqual([])
  })

  it('保持用户自己的顺序，不做相关度重排', () => {
    const hits = searchLibrary(lib, 'https')
    expect(hits.map((h) => h.collection.name)).toEqual(['生产巡检', '测试环境'])
    expect(hits[0]!.requests.map((r) => r.spec.name)).toEqual(['查订单', '重启服务'])
  })
})
