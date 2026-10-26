import { toVarMap, type Environment, type Param, type VarMap } from '@curlviz/core'

/**
 * 多环境变量。
 *
 * 直接复用 core 的 `Environment[]` 形状与 `toVarMap` 的分层语义，理由有两个：
 * 一是 M3 安卓侧要读同一份集合 JSON，形状不能各发明一套；
 * 二是 core 里那条规则已经定死了 —— **激活环境的同名变量覆盖其他环境，其他环境作为兜底**，
 * 界面上得把这句话原样说给用户，否则"我在测试环境里改了 gw 怎么没生效"这种问题无法自证。
 *
 * 环境按**名字**寻址（不用 id）：core 的 toVarMap 就是按 name 挑激活环境，
 * 换成 id 反而两端对不上；代价是重名要靠 uniqueName 挡住。
 */

export interface EnvState {
  environments: Environment[]
  /** null 表示"不启用任何环境"，此时 {{变量}} 原样发出去。 */
  activeName: string | null
}

export const DEFAULT_ENV_NAME = '默认'

export function emptyEnvs(): EnvState {
  return { environments: [{ name: DEFAULT_ENV_NAME, variables: [] }], activeName: DEFAULT_ENV_NAME }
}

export function uniqueEnvName(state: EnvState, wanted: string): string {
  const base = wanted.trim() || '未命名环境'
  const taken = new Set(state.environments.map((e) => e.name))
  if (!taken.has(base)) return base
  let n = 2
  while (taken.has(`${base} (${n})`)) n++
  return `${base} (${n})`
}

export function addEnv(state: EnvState, name: string, variables: Param[] = []): { state: EnvState; name: string } {
  const final = uniqueEnvName(state, name)
  return {
    state: { environments: [...state.environments, { name: final, variables }], activeName: state.activeName },
    name: final
  }
}

/** 改名要保持变量跟着走；如果激活的是它，激活名也一起改，否则用户会突然"掉出"当前环境。 */
export function renameEnv(state: EnvState, oldName: string, wanted: string): EnvState {
  const target = state.environments.find((e) => e.name === oldName)
  if (!target) return state
  const takenElse = new Set(state.environments.filter((e) => e.name !== oldName).map((e) => e.name))
  let next = wanted.trim()
  if (next === '') return state
  if (takenElse.has(next)) {
    let n = 2
    while (takenElse.has(`${next} (${n})`)) n++
    next = `${next} (${n})`
  }
  return {
    activeName: state.activeName === oldName ? next : state.activeName,
    environments: state.environments.map((e) => (e.name === oldName ? { name: next, variables: e.variables } : e))
  }
}

export function removeEnv(state: EnvState, name: string): EnvState {
  const environments = state.environments.filter((e) => e.name !== name)
  return {
    environments,
    activeName: state.activeName === name ? null : state.activeName
  }
}

export function setActive(state: EnvState, name: string | null): EnvState {
  if (name !== null && !state.environments.some((e) => e.name === name)) return state
  return { ...state, activeName: name }
}

export function activeEnv(state: EnvState): Environment | undefined {
  return state.activeName === null ? undefined : state.environments.find((e) => e.name === state.activeName)
}

/** 环境不存在就原样返回（保持引用相等，免得 UI 白白重渲染）。 */
function withEnv(state: EnvState, envName: string, change: (env: Environment) => Environment): EnvState {
  if (!state.environments.some((e) => e.name === envName)) return state
  return { ...state, environments: state.environments.map((e) => (e.name === envName ? change(e) : e)) }
}

export function upsertVar(state: EnvState, envName: string, key: string, value: string, enabled = true): EnvState {
  const trimmed = key.trim()
  if (trimmed === '') return state
  return withEnv(state, envName, (env) => {
    const hit = env.variables.some((v) => v.key === trimmed)
    const variables = hit
      ? env.variables.map((v) => (v.key === trimmed ? { ...v, value, enabled } : v))
      : [...env.variables, { key: trimmed, value, enabled }]
    return { ...env, variables }
  })
}

export function setVars(state: EnvState, envName: string, variables: Param[]): EnvState {
  return withEnv(state, envName, (env) => ({ ...env, variables }))
}

export function removeVar(state: EnvState, envName: string, key: string): EnvState {
  return withEnv(state, envName, (env) => ({ ...env, variables: env.variables.filter((v) => v.key !== key) }))
}

/**
 * 当前实际生效的变量表（含其他环境的兜底值）。
 *
 * 没有激活环境时必须返回空表：core 的 toVarMap 在不给 activeName 时是把所有环境合并，
 * 那等于"我明明没选环境，{{gw}} 却还是被某个环境的值替换了"。
 */
export function varsFor(state: EnvState): VarMap {
  if (state.activeName === null) return {}
  return toVarMap(state.environments, state.activeName)
}

/** 某个变量名的来源：激活环境优先，其次别的环境，用于界面上标"这条来自 测试 环境"。 */
export function varOrigin(state: EnvState, key: string): string | null {
  const active = activeEnv(state)
  if (active && active.variables.some((v) => v.key === key && v.enabled)) return active.name
  for (const env of state.environments) {
    if (env.variables.some((v) => v.key === key && v.enabled)) return env.name
  }
  return null
}

/**
 * 变量表格里该出现哪些行：这个环境已有的变量，加上命令里用到、而它没有的变量（空值待填）。
 * 后半段是为省事的 —— 命令里写了 {{gw}}，界面上就该有 gw 这一行，不该让用户自己对照着敲名字。
 */
export function rowsForEditor(env: Environment | undefined, used: string[]): Param[] {
  if (!env) return []
  const rows: Param[] = env.variables.map((v) => ({ ...v }))
  const known = new Set(rows.map((v) => v.key))
  for (const key of used) if (!known.has(key)) rows.push({ key, value: '', enabled: true })
  return rows
}

/**
 * 把编辑器里的行写回环境。两条丢弃规则：
 *  - 键名空的不存；
 *  - 值为空、且这个环境原本没有该键的也不存 —— 那行只是上面那种"占位待填"，
 *    存进去会让环境里堆一堆空变量，还会让人误以为 {{x}} 已经被赋值成空串。
 * 同名重复行只保留最后一次编辑的值，用户手滑拖出两行同样键名时不该出现两个真相。
 */
export function commitRows(env: Environment, rows: Param[]): Param[] {
  const existed = new Set(env.variables.map((v) => v.key))
  const out: Param[] = []
  for (const r of rows) {
    const key = r.key.trim()
    if (key === '') continue
    if (r.value === '' && !existed.has(key)) continue
    const at = out.findIndex((v) => v.key === key)
    const param: Param = { key, value: r.value, enabled: r.enabled }
    if (at >= 0) out[at] = param
    else out.push(param)
  }
  return out
}

/**
 * M1 的变量是一整张扁平表（storage 里的 vars）。升上来时并进「默认」环境，
 * 一个值都不丢；已经有同名变量时不覆盖，把旧的挪进"（旧值）"注释性的键名反而添乱，
 * 所以直接保留环境里原有的，把差异交给界面提示。
 */
export function migrateLegacyVars(
  state: EnvState,
  legacy: Record<string, string> | undefined | null
): { state: EnvState; migrated: number; conflicts: string[] } {
  if (!legacy || Object.keys(legacy).length === 0) return { state, migrated: 0, conflicts: [] }
  const existing = state.environments.find((e) => e.name === DEFAULT_ENV_NAME)
  const base: Param[] = existing ? existing.variables.map((v) => ({ ...v })) : []
  const byKey = new Map(base.map((v) => [v.key, v]))
  const conflicts: string[] = []
  let migrated = 0
  for (const [key, value] of Object.entries(legacy)) {
    const hit = byKey.get(key)
    if (hit) {
      if (hit.value !== value) conflicts.push(key)
      continue
    }
    const param: Param = { key, value, enabled: true }
    byKey.set(key, param)
    base.push(param)
    migrated++
  }
  if (migrated === 0 && conflicts.length === 0) return { state, migrated: 0, conflicts: [] }
  const environments = existing
    ? state.environments.map((e) => (e.name === DEFAULT_ENV_NAME ? { ...e, variables: base } : e))
    : [...state.environments, { name: DEFAULT_ENV_NAME, variables: base }]
  return { state: { ...state, environments }, migrated, conflicts }
}

/** 导入的集合 JSON 里带环境时并进来；同名环境不覆盖，改加序号。 */
export function mergeEnvironments(
  state: EnvState,
  incoming: Environment[]
): { state: EnvState; added: string[] } {
  const added: string[] = []
  let next = state
  for (const env of incoming) {
    const name = uniqueEnvName(next, env.name)
    if (name !== env.name) added.push(`${name}（原名 ${env.name}）`)
    else added.push(name)
    next = { ...addEnv(next, name, env.variables.map((v) => ({ ...v }))).state }
  }
  return { state: next, added }
}

/**
 * 把 localStorage 里读出来的东西收敛成合法 EnvState。
 * 旧版本、手改过的、写一半掉电的数据都可能在这里出现；不收敛的话界面会在
 * `environments.map` 那一刻崩，而且崩在用户打开页面第一眼 —— 比报错更难查。
 * 原则与 core 的 normalizeSpec 一样：认得出的留下，认不出的一律丢掉并说明。
 */
export function sanitizeEnvState(value: unknown): EnvState {
  if (typeof value !== 'object' || value === null) return emptyEnvs()
  const o = value as Record<string, unknown>
  const raw = Array.isArray(o.environments) ? o.environments : []
  const environments: Environment[] = []
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue
    const e = item as Record<string, unknown>
    const name = typeof e.name === 'string' ? e.name.trim() : ''
    if (name === '' || environments.some((x) => x.name === name)) continue
    const variables: Param[] = []
    for (const v of Array.isArray(e.variables) ? e.variables : []) {
      if (typeof v !== 'object' || v === null) continue
      const p = v as Record<string, unknown>
      if (typeof p.key !== 'string' || p.key.trim() === '') continue
      if (variables.some((x) => x.key === p.key)) continue
      variables.push({ key: p.key, value: typeof p.value === 'string' ? p.value : '', enabled: p.enabled !== false })
    }
    environments.push({ name, variables })
  }
  if (environments.length === 0) return emptyEnvs()
  const active = typeof o.activeName === 'string' ? o.activeName : null
  return { environments, activeName: active !== null && environments.some((e) => e.name === active) ? active : null }
}
