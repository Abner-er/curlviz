import {
  buildCollection,
  createDefaultSpec,
  hasSensitive,
  normalizeSpec,
  parseCollection,
  redactSpec,
  serializeCollection,
  type Collection,
  type CurlSpec,
  type Environment
} from '@curlviz/core'

/**
 * 集合（collections）的纯函数层。
 *
 * 界面只负责把这里的返回值画出来并写进 localStorage，所有增删改都做成
 * 「进一份状态、出一份新状态」的纯函数 —— 这样脱敏、导入合并、重名处理这些
 * 容易出错的地方能脱离浏览器单测，M3 安卓侧也能照同一套语义实现。
 *
 * id 必须由这里生成，不能用数组下标：列表会排序、会删除，下标当 id 迟早把请求存错集合。
 */

export interface StoredRequest {
  id: string
  spec: CurlSpec
  /** 最后一次保存时间，列表上显示"改过没有"。 */
  updatedAt: number
}

export interface StoredCollection {
  id: string
  name: string
  requests: StoredRequest[]
}

export interface CollectionState {
  collections: StoredCollection[]
}

export const EMPTY_COLLECTION_STATE: CollectionState = { collections: [] }

/**
 * 编辑器里这条 spec 与集合库的关系。
 * 放在数据层而不是组件里，是因为它要落 localStorage、要在启动时读回来 ——
 * 刷新后还认得"我在改的是哪一条"，才谈得上"就地更新"而不是又存出一条重复的。
 */
export interface OpenRef {
  collectionId: string | null
  requestId: string | null
}

export const NO_OPEN_REF: OpenRef = { collectionId: null, requestId: null }

/**
 * 生成 id。
 * 注意不能用 crypto.randomUUID —— 那是安全上下文专属 API，内网用 http://10.x.x.x 打开本工具时
 * 它是 undefined，一调就抛。所以先试再退回时间戳+随机数，别拿工具的可用性赌部署环境。
 */
export function newId(prefix = 'id'): string {
  const uuid = globalThis.crypto?.randomUUID?.()
  if (uuid) return `${prefix}_${uuid.slice(0, 18)}`
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

/* ------------------------------------------------------------------ */
/* 集合级操作                                                          */
/* ------------------------------------------------------------------ */

export function makeCollection(name: string, requests: CurlSpec[] = []): StoredCollection {
  const now = Date.now()
  return {
    id: newId('col'),
    name: name.trim() || '未命名集合',
    requests: requests.map((spec) => ({ id: newId('req'), spec, updatedAt: now }))
  }
}

/** 重名不报错也不静默合并，加个序号 —— 运维同时开"生产""生产"两份集合是很常见的。 */
export function uniqueCollectionName(state: CollectionState, wanted: string): string {
  const base = wanted.trim() || '未命名集合'
  const taken = new Set(state.collections.map((c) => c.name))
  if (!taken.has(base)) return base
  let n = 2
  while (taken.has(`${base} (${n})`)) n++
  return `${base} (${n})`
}

export function addCollection(state: CollectionState, name: string): { state: CollectionState; id: string } {
  const col = makeCollection(uniqueCollectionName(state, name))
  return { state: { collections: [...state.collections, col] }, id: col.id }
}

export function renameCollection(state: CollectionState, id: string, name: string): CollectionState {
  const trimmed = name.trim()
  if (trimmed === '') return state
  return { collections: state.collections.map((c) => (c.id === id ? { ...c, name: trimmed } : c)) }
}

export function removeCollection(state: CollectionState, id: string): CollectionState {
  return { collections: state.collections.filter((c) => c.id !== id) }
}

/* ------------------------------------------------------------------ */
/* 请求级操作                                                          */
/* ------------------------------------------------------------------ */

/** 保存当前编辑态：给了 id 且集合里存在就是覆盖，否则新加一条。 */
export function saveRequest(
  state: CollectionState,
  collectionId: string,
  spec: CurlSpec,
  requestId?: string
): { state: CollectionState; id: string; created: boolean } {
  const target = state.collections.find((c) => c.id === collectionId)
  if (!target) return { state, id: requestId ?? '', created: false }
  const now = Date.now()
  if (requestId && target.requests.some((r) => r.id === requestId)) {
    const next = state.collections.map((c) =>
      c.id === collectionId
        ? { ...c, requests: c.requests.map((r) => (r.id === requestId ? { ...r, spec: normalizeSpec(spec), updatedAt: now } : r)) }
        : c
    )
    return { state: { collections: next }, id: requestId, created: false }
  }
  const fresh: StoredRequest = { id: newId('req'), spec: normalizeSpec(spec), updatedAt: now }
  const next = state.collections.map((c) => (c.id === collectionId ? { ...c, requests: [...c.requests, fresh] } : c))
  return { state: { collections: next }, id: fresh.id, created: true }
}

export function removeRequest(state: CollectionState, collectionId: string, requestId: string): CollectionState {
  return {
    collections: state.collections.map((c) =>
      c.id === collectionId ? { ...c, requests: c.requests.filter((r) => r.id !== requestId) } : c
    )
  }
}

/** 复制一份到同一集合末尾（带"副本"名字，避免看起来像两个一模一样的东西）。 */
export function duplicateRequest(
  state: CollectionState,
  collectionId: string,
  requestId: string
): { state: CollectionState; id: string } {
  const target = state.collections.find((c) => c.id === collectionId)?.requests.find((r) => r.id === requestId)
  if (!target) return { state, id: '' }
  const spec = normalizeSpec(target.spec)
  spec.name = `${spec.name || '未命名请求'} 副本`
  const fresh: StoredRequest = { id: newId('req'), spec, updatedAt: Date.now() }
  const next = state.collections.map((c) =>
    c.id === collectionId ? { ...c, requests: insertAfter(c.requests, requestId, fresh) } : c
  )
  return { state: { collections: next }, id: fresh.id }
}

function insertAfter(list: StoredRequest[], id: string, item: StoredRequest): StoredRequest[] {
  const at = list.findIndex((r) => r.id === id)
  return [...list.slice(0, at + 1), item, ...list.slice(at + 1)]
}

/** 跨集合移动；目标集合不存在就当没发生，不静默丢请求。 */
export function moveRequest(
  state: CollectionState,
  fromId: string,
  requestId: string,
  toId: string
): CollectionState {
  if (fromId === toId) return state
  const from = state.collections.find((c) => c.id === fromId)
  const to = state.collections.find((c) => c.id === toId)
  if (!from || !to) return state
  const moving = from.requests.find((r) => r.id === requestId)
  if (!moving) return state
  return {
    collections: state.collections.map((c) => {
      if (c.id === fromId) return { ...c, requests: c.requests.filter((r) => r.id !== requestId) }
      if (c.id === toId) return { ...c, requests: [...c.requests, moving] }
      return c
    })
  }
}

export function findRequest(state: CollectionState, collectionId: string, requestId: string): StoredRequest | undefined {
  return state.collections.find((c) => c.id === collectionId)?.requests.find((r) => r.id === requestId)
}

/** 整库里按 id 找（导入的分享链接只带请求 id 时也能定位到集合）。 */
export function locateRequest(state: CollectionState, requestId: string): StoredRequest | undefined {
  for (const c of state.collections) {
    const hit = c.requests.find((r) => r.id === requestId)
    if (hit) return hit
  }
  return undefined
}

export function requestCount(state: CollectionState): number {
  return state.collections.reduce((sum, c) => sum + c.requests.length, 0)
}

/* ------------------------------------------------------------------ */
/* 搜索（左栏资料库）                                                   */
/* ------------------------------------------------------------------ */

export interface LibraryMatch {
  collection: StoredCollection
  /** 命中的请求。集合名本身命中时是它的全部请求。 */
  requests: StoredRequest[]
  /** 集合名命中：界面据此决定整块展开，而不是只挑命中的那几条。 */
  nameHit: boolean
}

/** 一条请求里可被搜到的文本：名称、URL、方法，以及头名 / 参数名（不含值）。 */
function requestHaystack(req: StoredRequest): string {
  const keys = [...req.spec.headers, ...req.spec.query].filter((p) => p.enabled).map((p) => p.key)
  return [req.spec.name, req.spec.url, req.spec.method, ...keys].join('\n').toLowerCase()
}

/**
 * 按关键字过滤集合库。
 *
 * - 空查询返回**全部集合 + 全部请求**，让面板只有一条渲染路径，不必区分"搜索态"
 * - 集合名命中 → 整个集合算命中，带出它的所有请求
 * - 否则只带出命中的请求；一条都不中的集合从结果里消失
 * - **保持用户自己的顺序**，不做相关度排序：这个库是人手工整理的，
 *   搜一次就重排一次会让"我那条明明排第一的"突然找不到
 * - 不搜值：值里常是凭据与环境数据，命中列表既不是要找的东西，
 *   又会把 token 半截显示在屏幕上
 */
export function searchLibrary(state: CollectionState, query: string): LibraryMatch[] {
  const q = query.trim().toLowerCase()
  if (q === '') {
    return state.collections.map((collection) => ({ collection, requests: collection.requests, nameHit: false }))
  }
  const out: LibraryMatch[] = []
  for (const collection of state.collections) {
    if (collection.name.toLowerCase().includes(q)) {
      out.push({ collection, requests: collection.requests, nameHit: true })
      continue
    }
    const hits = collection.requests.filter((r) => requestHaystack(r).includes(q))
    if (hits.length > 0) out.push({ collection, requests: hits, nameHit: false })
  }
  return out
}

/* ------------------------------------------------------------------ */
/* 导入导出                                                            */
/* ------------------------------------------------------------------ */

/**
 * 导出成 PLAN 里定的集合 JSON。redact=true 时凭据在离开这个函数之前就被抹掉。
 * environments 默认不带 —— 导出请求这件事不该把别的环境里的内网地址一起捎出去，
 * 要连带环境导出时由界面明确勾选。
 */
export function toCollectionFile(col: StoredCollection, redact: boolean, environments: Environment[] = []): string {
  const specs = col.requests.map((r) => (redact ? redactSpec(normalizeSpec(r.spec)) : normalizeSpec(r.spec)))
  return serializeCollection(buildCollection(specs, environments))
}

export function toRequestFile(spec: CurlSpec, redact: boolean): string {
  const target = redact ? redactSpec(normalizeSpec(spec)) : normalizeSpec(spec)
  return serializeCollection(buildCollection([target]))
}

export interface ImportResult {
  collection: Collection
  /** 导入文件里有多少条带凭据（用来提示"这份没脱敏"）。 */
  sensitiveCount: number
}

/** 解析外部 JSON；错误直接以字符串返回，交给界面显示，不抛异常打断操作流。 */
export function parseCollectionText(text: string): { ok: true } & ImportResult | { ok: false; error: string } {
  try {
    const collection = parseCollection(text)
    return { ok: true, collection, sensitiveCount: collection.requests.filter((r) => hasSensitive(r)).length }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

/**
 * 合并导入：作为**新集合**入库，并把 id 全部换成新的。
 * 刻意不做"按名字合并进同名集合"——导入的文件里可能带同名请求，
 * 静默覆盖用户自己存的东西比多出一个集合糟糕得多。
 */
export function mergeImported(
  state: CollectionState,
  collection: Collection,
  name?: string
): { state: CollectionState; id: string; skipped: number } {
  let skipped = 0
  const requests: StoredRequest[] = []
  const now = Date.now()
  for (const raw of collection.requests) {
    try {
      requests.push({ id: newId('req'), spec: normalizeSpec(raw), updatedAt: now })
    } catch {
      skipped++
    }
  }
  const col: StoredCollection = {
    id: newId('col'),
    name: uniqueCollectionName(state, name || collection.environments[0]?.name || '导入的集合'),
    requests
  }
  return { state: { collections: [...state.collections, col] }, id: col.id, skipped }
}

/** 集合 JSON 里的 environments 与本地环境是分开的东西，导入时单独取出来。 */
export function environmentsFrom(collection: Collection): Environment[] {
  return collection.environments
    .map((e) => ({ name: e.name, variables: e.variables.map((v) => ({ ...v })) }))
    .filter((e) => e.name.trim() !== '')
}

/** 兜底：导入内容不是集合而是裸 CurlSpec 数组 / 单个 spec 时，也能接住。 */
export function coerceCollection(value: unknown): Collection | null {
  if (Array.isArray(value)) {
    const requests = value.filter((v) => looksLikeSpec(v)).map((v) => normalizeSpec(v))
    if (requests.length > 0) return buildCollection(requests)
    return null
  }
  if (looksLikeSpec(value)) return buildCollection([normalizeSpec(value as unknown as CurlSpec)])
  return null
}

function looksLikeSpec(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false
  const o = value as Record<string, unknown>
  // 有 url 才算请求；带 format 的是集合文件，别把它当成一条 spec 吞进去
  return typeof o.url === 'string' && !('format' in o)
}

/** 空集合的默认基线，UI 直接拿来当初始 spec。 */
export function blankRequest(): CurlSpec {
  return createDefaultSpec('未命名请求')
}

/**
 * 把 localStorage 里读出来的集合数据收敛成合法 CollectionState。
 * 与 core 的 normalizeSpec 同一套哲学：坏数据一律丢掉而不是让界面去崩。
 * URL 为空的请求直接丢弃 —— 打不出目标的命令存在库里只会让人以为东西丢了。
 */
export function sanitizeCollectionState(value: unknown): CollectionState {
  const raw =
    typeof value === 'object' && value !== null && Array.isArray((value as { collections?: unknown }).collections)
      ? ((value as { collections: unknown[] }).collections)
      : []
  const collections: StoredCollection[] = []
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue
    const c = item as Record<string, unknown>
    const rawName = typeof c.name === 'string' ? c.name.trim() : ''
    const requests: StoredRequest[] = []
    for (const r of Array.isArray(c.requests) ? c.requests : []) {
      if (typeof r !== 'object' || r === null) continue
      const entry = r as Record<string, unknown>
      const spec = normalizeSpec(entry.spec)
      if (spec.url.trim() === '') continue
      requests.push({
        id: typeof entry.id === 'string' && entry.id !== '' ? entry.id : newId('req'),
        spec,
        updatedAt: typeof entry.updatedAt === 'number' ? entry.updatedAt : Date.now()
      })
    }
    // 没名字但里面东西还在：改名留下，扔用户的东西比给它起个名糟糕得多
    if (rawName === '' && requests.length === 0) continue
    const name = rawName === '' ? '未命名集合' : rawName
    // id 必须原样保留：openRef 记的就是集合 id，换了 id 刷新后"更新原条目"会静默找不到
    const id = typeof c.id === 'string' && c.id !== '' ? c.id : newId('col')
    if (collections.some((x) => x.id === id)) continue
    collections.push({ id, name, requests })
  }
  return { collections }
}

/**
 * 收敛 openRef。指向的东西已经不在了（集合被删、请求被删）就降级成"没打开任何条目"，
 * 否则用户点「更新原条目」会往一个不存在的 id 上写，界面还以为存好了。
 */
export function sanitizeOpenRef(value: unknown, state: CollectionState): OpenRef {
  if (typeof value !== 'object' || value === null) return NO_OPEN_REF
  const o = value as Record<string, unknown>
  const collectionId = typeof o.collectionId === 'string' ? o.collectionId : null
  const requestId = typeof o.requestId === 'string' ? o.requestId : null
  if (collectionId === null || requestId === null) return NO_OPEN_REF
  const col = state.collections.find((c) => c.id === collectionId)
  if (!col || !col.requests.some((r) => r.id === requestId)) return NO_OPEN_REF
  return { collectionId, requestId }
}
