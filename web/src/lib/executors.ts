import { newId } from './collections'
import type { TransportSelector } from '../types'

/**
 * 执行机注册表（M4 远程执行）。
 *
 * 一条执行机 = ECS 上跑着 agent 的一台机器。界面把它当"发送的另一条路"来选：
 * 选中某台，就走那台机器上的真 curl；没选中就走浏览器 fetch。
 *
 * 落盘的只有 {id,name,baseUrl} 三样 —— token 绝不写进 localStorage（决策②）。
 * 理由很实在：localStorage 是这台机器上任何同站脚本都能读的明文，而执行机的 token
 * 等于"用运维的身份发任意内网请求"的钥匙；把它落盘，就把免登录不过云的本地工具
 * 变成了一个长期驻留凭据的密码本。所以 token 只活在会话内存里（调用方自持），
 * 刷新页面即失效、要重新填 —— 宁可多敲一次，也不把钥匙埋进磁盘。
 */

/** 存进 localStorage 的执行机：没有 token 这个字段，从类型上就不给落盘的机会。 */
export interface StoredExecutor {
  id: string
  name: string
  /** agent 根地址，如 https://ecs-1.internal；发送时拼 /exec，所以这里不带 /exec。 */
  baseUrl: string
}

/** 注册表落盘形状。activeId=null 表示"当前走浏览器 fetch"。 */
export interface ExecutorRegistry {
  executors: StoredExecutor[]
  activeId: string | null
}

export const NO_EXECUTORS: ExecutorRegistry = { executors: [], activeId: null }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function trimmedString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * 读回来的数据先收敛形状：坏条目（缺 id/name/baseUrl、类型不对、id 重复）直接丢，
 * activeId 悬空（指着一个已经不存在的执行机）就回落成浏览器。
 * 目标是"读到脏数据不把界面搞崩、也不画出一条发不出去的执行机"。
 */
export function sanitizeRegistry(raw: unknown): ExecutorRegistry {
  if (!isRecord(raw)) return { executors: [], activeId: null }
  const list = Array.isArray(raw.executors) ? raw.executors : []
  const seen = new Set<string>()
  const executors: StoredExecutor[] = []
  for (const item of list) {
    if (!isRecord(item)) continue
    const id = trimmedString(item.id)
    const name = trimmedString(item.name)
    const baseUrl = trimmedString(item.baseUrl)
    if (id === '' || name === '' || baseUrl === '') continue
    if (seen.has(id)) continue
    seen.add(id)
    executors.push({ id, name, baseUrl })
  }
  const activeId = typeof raw.activeId === 'string' && seen.has(raw.activeId) ? raw.activeId : null
  return { executors, activeId }
}

/** 新增一条：返回新注册表和新建那条（好让调用方当场把它的 token 塞进会话内存）。 */
export function addExecutor(
  reg: ExecutorRegistry,
  input: { name: string; baseUrl: string },
  id: string = newId('ex')
): { registry: ExecutorRegistry; executor: StoredExecutor } {
  const executor: StoredExecutor = { id, name: input.name.trim(), baseUrl: input.baseUrl.trim() }
  return { registry: { ...reg, executors: [...reg.executors, executor] }, executor }
}

/** 改一条（id 不参与改）。找不到 id 就原样返回。 */
export function updateExecutor(
  reg: ExecutorRegistry,
  id: string,
  patch: Partial<Omit<StoredExecutor, 'id'>>
): ExecutorRegistry {
  return {
    ...reg,
    executors: reg.executors.map((e) =>
      e.id === id ? { ...e, ...(patch.name !== undefined ? { name: patch.name.trim() } : {}), ...(patch.baseUrl !== undefined ? { baseUrl: patch.baseUrl.trim() } : {}) } : e
    )
  }
}

/**
 * 删一条。若删的正是当前选中的那台，activeId 回落成浏览器 —— 不能留一个指向已删
 * 执行机的悬空选择，否则 buildTransport 会拿不到 token 的那台硬拼一次发送。
 */
export function removeExecutor(reg: ExecutorRegistry, id: string): ExecutorRegistry {
  return {
    executors: reg.executors.filter((e) => e.id !== id),
    activeId: reg.activeId === id ? null : reg.activeId
  }
}

/** 选择当前走哪台：null = 浏览器 fetch；给的 id 不存在也回落成浏览器。 */
export function setActive(reg: ExecutorRegistry, id: string | null): ExecutorRegistry {
  if (id === null) return { ...reg, activeId: null }
  return reg.executors.some((e) => e.id === id) ? { ...reg, activeId: id } : reg
}

/**
 * 把注册表 + 会话里的 token 表合成 sendSpec 要的 TransportSelector。
 * token 只可能来自 sessions（内存）—— 落盘那份根本没有 token，这里也不去读。
 * 悬空选择（activeId 指着一个已不存在的执行机）兜底走浏览器，绝不假装发得出去。
 */
export function buildTransport(reg: ExecutorRegistry, tokens: Record<string, string>): TransportSelector {
  if (reg.activeId === null) return { kind: 'browser' }
  const ex = reg.executors.find((e) => e.id === reg.activeId)
  if (!ex) return { kind: 'browser' }
  return { kind: 'agent', executor: { id: ex.id, name: ex.name, baseUrl: ex.baseUrl, token: tokens[ex.id] ?? '' } }
}
