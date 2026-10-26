import type { CurlSpec } from '@curlviz/core'
import {
  mergeImported,
  environmentsFrom,
  NO_OPEN_REF,
  sanitizeCollectionState,
  sanitizeOpenRef,
  type CollectionState,
  type OpenRef
} from './collections'
import {
  DEFAULT_ENV_NAME,
  emptyEnvs,
  migrateLegacyVars,
  mergeEnvironments,
  sanitizeEnvState,
  type EnvState
} from './environments'
import { KEYS, type Store } from './storage'
import { SHARE_HASH_KEY, type SharePayload } from './share'

/**
 * 启动时把 localStorage 里的东西读成能用的状态。
 *
 * 单独成模块的原因：这几步的顺序（先收敛形状 → 再迁移 M1 旧变量 → 再校验 openRef 还指得上去）
 * 是有依赖的，散在组件里既没法测也没人保证顺序；而"读到坏数据不能把界面搞崩"这件事必须钉成测试。
 */

export interface BootState {
  colState: CollectionState
  envState: EnvState
  openRef: OpenRef
  /** 真的把 M1 的扁平变量搬进环境了 —— 上层据此删掉旧键，避免每次开机重复迁移。 */
  didMigrate: boolean
  /** 需要告诉用户的一句话（迁移了什么、载入了什么）；没有就 null。 */
  note: string | null
}

export function loadBootState(store: Store): BootState {
  const colState = sanitizeCollectionState(store.load(KEYS.collections, { collections: [] }))
  const baseEnv = sanitizeEnvState(store.load(KEYS.environments, emptyEnvs()))
  const legacy = onlyStrings(store.load<unknown>(KEYS.vars, {}))
  const migrated = migrateLegacyVars(baseEnv, legacy)

  const bits: string[] = []
  if (migrated.migrated > 0) bits.push(`把 M1 存下的 ${migrated.migrated} 个变量并进了「${DEFAULT_ENV_NAME}」环境`)
  if (migrated.conflicts.length > 0) bits.push(`${migrated.conflicts.join('、')} 与环境里已有变量同名，保留了环境的值`)
  if (colState.collections.length > 0) {
    const total = colState.collections.reduce((n, c) => n + c.requests.length, 0)
    bits.push(`集合库载入 ${colState.collections.length} 个集合 / ${total} 条请求`)
  }

  return {
    colState,
    envState: migrated.state,
    openRef: sanitizeOpenRef(store.load(KEYS.openRef, NO_OPEN_REF), colState),
    didMigrate: migrated.migrated > 0,
    note: bits.length > 0 ? `${bits.join('；')}。` : null
  }
}

function onlyStrings(value: unknown): Record<string, string> {
  if (typeof value !== 'object' || value === null) return {}
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v === 'string') out[k] = v
  }
  return out
}

export interface ShareApply {
  colState: CollectionState
  envState: EnvState
  /** 单请求分享：直接替换编辑器内容。 */
  spec: CurlSpec | null
  /** 集合分享：新集合的 id，便于界面提示"存到了哪个集合"。 */
  collectionId: string | null
  note: string
  warn: boolean
}

/**
 * 把解开的分享载荷落到状态里。粘贴导入与 #share= 链接两条路共用这一份逻辑，
 * 免得同一句"这是脱敏版，凭据要自己填"在两个地方说法不一致。
 */
export function applySharePayload(payload: SharePayload, colState: CollectionState, envState: EnvState): ShareApply {
  if (payload.kind === 'request' && payload.spec) {
    return {
      colState,
      envState,
      spec: payload.spec,
      collectionId: null,
      note: payload.redacted ? '已导入这个请求。它是脱敏版，凭据被抹成 ••••••••，要自己填。' : '已导入这个请求。',
      warn: payload.redacted
    }
  }
  const collection = payload.collection
  if (!collection) {
    return { colState, envState, spec: null, collectionId: null, note: '分享码解开了，可里面既没有请求也没有集合。', warn: true }
  }
  const merged = mergeImported(colState, collection)
  const envs = environmentsFrom(collection)
  const envResult = envs.length > 0 ? mergeEnvironments(envState, envs) : { state: envState, added: [] as string[] }
  let note = `已把分享来的 ${collection.requests.length} 条请求存成新集合。`
  if (payload.redacted) note += ' 这是脱敏版，凭据要自己填。'
  if (envResult.added.length > 0) note += ` 附带环境：${envResult.added.join('、')}。`
  return { colState: merged.state, envState: envResult.state, spec: null, collectionId: merged.id, note, warn: payload.redacted }
}

/** 从 location.hash 里判断有没有分享码（真正的解码与校验在 lib/share）。 */
export function hasShareHash(hash: string | undefined): boolean {
  return (hash ?? '').includes(`${SHARE_HASH_KEY}=`)
}
