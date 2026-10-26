/**
 * 整体备份 / 恢复：集合 + 环境 + 当前激活项，一份 JSON 全带走。
 *
 * 为什么在"集合 JSON"之外还要再做一个格式：集合 JSON 是**跨工具的可移植契约**
 * （core 定义，安卓与别的工具都要认），它装不下"这是几个集合、当前选哪个环境"这些本机概念。
 * 换浏览器 / 换机器时用户要的恰恰是把这些一起搬走，所以这里单独一个 format，
 * 并且明说它不是契约的一部分 —— 导入时先认这个 format，认不出再退回集合 JSON。
 *
 * 恢复策略与 mergeImported 一致：**永不覆盖**用户已有的东西，全部当新数据入库、重名加序号。
 * 备份文件可能是别人发来的、也可能是旧版本，静默合并的破坏面比多出一个集合大得多。
 */

import { normalizeSpec, type Environment, type Param } from '@curlviz/core'
import { newId, uniqueCollectionName, type CollectionState, type StoredCollection, type StoredRequest } from './collections'
import { uniqueEnvName, type EnvState } from './environments'

export const BACKUP_FORMAT = 'curlviz-backup'
export const BACKUP_VERSION = 1

export interface BackupData {
  format: typeof BACKUP_FORMAT
  version: number
  exportedAt: number
  app: string
  collections: StoredCollection[]
  environments: Environment[]
  activeName: string | null
}

export function buildBackup(colState: CollectionState, envState: EnvState): BackupData {
  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    exportedAt: Date.now(),
    app: 'CurlViz',
    collections: colState.collections.map((c) => ({
      id: c.id,
      name: c.name,
      requests: c.requests.map((r) => ({ id: r.id, updatedAt: r.updatedAt, spec: normalizeSpec(r.spec) }))
    })),
    environments: envState.environments.map((e) => ({ name: e.name, variables: e.variables.map((v) => ({ ...v })) })),
    activeName: envState.activeName
  }
}

export function serializeBackup(data: BackupData): string {
  return `${JSON.stringify(data, null, 2)}\n`
}

/** 一眼判断这份 JSON 是不是本工具的备份，好让导入流程排到正确的分支上（只扫开头，不必整份 parse 两次）。 */
export function looksLikeBackup(text: string): boolean {
  return text.slice(0, 2000).includes(BACKUP_FORMAT)
}

export type BackupParse = { ok: true; data: BackupData; skipped: number } | { ok: false; error: string }

export function parseBackup(text: string): BackupParse {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (e) {
    return { ok: false, error: `不是合法 JSON：${e instanceof Error ? e.message : String(e)}` }
  }
  if (typeof value !== 'object' || value === null) return { ok: false, error: '备份内容不是对象。' }
  const o = value as Record<string, unknown>
  if (o.format !== BACKUP_FORMAT) return { ok: false, error: `format 不是 ${BACKUP_FORMAT}，这份不是本工具的备份。` }
  const version = typeof o.version === 'number' ? o.version : 0
  if (version > BACKUP_VERSION) {
    return {
      ok: false,
      error: `这份备份来自更新的版本（v${version}），当前只会读 v${BACKUP_VERSION}。别猜格式，升级工具后再导入。`
    }
  }

  let skipped = 0
  const collections: StoredCollection[] = []
  for (const raw of Array.isArray(o.collections) ? o.collections : []) {
    const col = raw as Record<string, unknown>
    const name = typeof col.name === 'string' ? col.name : '未命名集合'
    const rawRequests = Array.isArray(col.requests) ? col.requests : []
    const requests: StoredRequest[] = []
    for (const rawReq of rawRequests) {
      const r = rawReq as Record<string, unknown>
      // normalizeSpec 太宽容，不会抛错：坏输入照样给出一条 url 为空的默认 spec，所以只能自己判有效性
      const normalized = normalizeSpec(r.spec)
      if (normalized.url.trim() === '') {
        skipped++
        continue
      }
      requests.push({
        id: typeof r.id === 'string' ? r.id : newId('req'),
        updatedAt: typeof r.updatedAt === 'number' ? r.updatedAt : Date.now(),
        spec: normalized
      })
    }
    // 原本有条目却一条都没解析出来 = 整集合都坏了，别塞个空集合进来装作没事
    if (rawRequests.length > 0 && requests.length === 0) continue
    collections.push({ id: typeof col.id === 'string' ? col.id : newId('col'), name, requests })
  }

  const environments: Environment[] = (Array.isArray(o.environments) ? o.environments : [])
    .map((raw) => {
      const e = raw as Record<string, unknown>
      const variables = Array.isArray(e.variables) ? e.variables : []
      return {
        name: typeof e.name === 'string' ? e.name : '',
        variables: variables
          .map((v) => {
            const p = v as Record<string, unknown>
            if (typeof p.key !== 'string') return null
            return {
              key: p.key,
              value: typeof p.value === 'string' ? p.value : '',
              enabled: p.enabled !== false
            } satisfies Param
          })
          .filter((v): v is Param => v !== null)
      }
    })
    .filter((e) => e.name.trim() !== '')

  return {
    ok: true,
    data: {
      format: BACKUP_FORMAT,
      version,
      exportedAt: typeof o.exportedAt === 'number' ? o.exportedAt : 0,
      app: typeof o.app === 'string' ? o.app : '',
      collections,
      environments,
      activeName: typeof o.activeName === 'string' ? o.activeName : null
    },
    skipped
  }
}

export interface BackupMergeResult {
  colState: CollectionState
  envState: EnvState
  addedCollections: number
  addedRequests: number
  /** 人类可读：`生产`、`默认 (2)（原名 默认）`。 */
  addedEnvironments: string[]
  /** 备份里的激活环境落到了哪个名字上；对不上就说清为什么没切。 */
  activeNote: string | null
}

export function mergeBackup(colState: CollectionState, envState: EnvState, data: BackupData): BackupMergeResult {
  let nextCol = colState
  let nextEnv = envState
  let addedRequests = 0
  const renamed: { from: string; to: string }[] = []

  for (const col of data.collections) {
    const name = uniqueCollectionName(nextCol, col.name)
    const fresh: StoredCollection = {
      id: newId('col'),
      name,
      // parseBackup 已经 normalize 过，这里的 id 一律换新：备份里的旧 id 不该跟本机撞
      requests: col.requests.map((r) => ({ id: newId('req'), updatedAt: r.updatedAt, spec: r.spec }))
    }
    nextCol = { collections: [...nextCol.collections, fresh] }
    addedRequests += fresh.requests.length
  }

  for (const env of data.environments) {
    const name = uniqueEnvName(nextEnv, env.name)
    nextEnv = {
      environments: [...nextEnv.environments, { name, variables: env.variables.map((v) => ({ ...v })) }],
      activeName: nextEnv.activeName
    }
    renamed.push({ from: env.name, to: name })
  }

  let activeNote: string | null = null
  if (data.activeName !== null) {
    const hit = renamed.find((r) => r.from === data.activeName)
    if (hit) {
      nextEnv = { ...nextEnv, activeName: hit.to }
      if (hit.to !== hit.from) activeNote = `激活环境切到「${hit.to}」（原名「${hit.from}」，本机已有同名，加了序号）`
    } else {
      activeNote = `备份里激活的是「${data.activeName}」，这次没对上名字，仍用你现在选的环境`
    }
  }

  return {
    colState: nextCol,
    envState: nextEnv,
    addedCollections: data.collections.length,
    addedRequests,
    addedEnvironments: renamed.map((r) => (r.from === r.to ? r.to : `${r.to}（原名 ${r.from}）`)),
    activeNote
  }
}
