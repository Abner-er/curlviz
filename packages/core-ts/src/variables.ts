/**
 * `{{name}}` 变量替换。
 *
 * 作用于 url / query / headers / body / auth / options.userAgent / options.proxy 的
 * 全部字符串值。未解析的变量**保持原样**并回报名字，由 UI 在发送前高亮提示
 * （而不是悄悄替换成空串——那会发出一个打到错误地址的请求，比报错更糟）。
 */

import type { CurlSpec, Environment, Param } from './types'
import { cloneSpec } from './types'

/**
 * 变量形态：`{{name}}`；`\{{name}}` 是**转义**，不参与替换，输出字面量 `{{name}}`。
 *
 * 替换走 String.replace 单趟扫描，插入的变量值不会被回头再扫一遍，
 * 所以「host={{base}} 引发链式展开」这种情况天然不存在，不必额外防护。
 * 转义语法解决的是另一件事：模板类 payload 里本来就要写
 * `{{item.name}}` 这种字面量，不转义会被报成"未解析变量"，用户被红点缠上。
 */
const VAR_TOKEN_RE = /\\?\{\{\s*([\w.-]+)\s*\}\}/g

export type VarMap = Record<string, string>

/** 从一段文本里取出全部变量名（去重，保序；被转义的 `\\{{x}}` 不算）。 */
export function extractVars(text: string): string[] {
  const out: string[] = []
  for (const m of text.matchAll(VAR_TOKEN_RE)) {
    if (m[0].startsWith('\\')) continue
    const name = m[1]
    if (name && !out.includes(name)) out.push(name)
  }
  return out
}

/** 替换单串文本；返回结果与其中未解析的变量名。 */
export function resolveText(text: string, vars: VarMap): { text: string; unresolved: string[] } {
  const unresolved: string[] = []
  const out = text.replace(VAR_TOKEN_RE, (whole, name: string) => {
    if (whole.startsWith('\\')) return whole.slice(1) // 转义：只吃掉反斜杠，变量标记还原为字面量
    const value = vars[name] as string | undefined
    if (value === undefined) {
      if (!unresolved.includes(name)) unresolved.push(name)
      return whole // 原样保留，让 UI 提示
    }
    return value
  })
  return { text: out, unresolved }
}

/** Environment[] 拍平成 VarMap；同名变量后者覆盖前者（与前端环境切换的直觉一致）。 */
export function toVarMap(environments: Environment[], activeName?: string): VarMap {
  const map: VarMap = {}
  const ordered = activeName
    ? [...environments.filter((e) => e.name !== activeName), ...environments.filter((e) => e.name === activeName)]
    : environments
  for (const env of ordered) {
    for (const v of env.variables) {
      if (!v.enabled) continue
      map[v.key] = v.value
    }
  }
  return map
}

/** 就地替换一个字符串数组里的变量，返回累计的未解析名。 */
function resolveList(items: Param[], vars: VarMap, sink: Set<string>): Param[] {
  return items.map((item) => {
    const k = resolveText(item.key, vars)
    const v = resolveText(item.value, vars)
    for (const n of k.unresolved) sink.add(n)
    for (const n of v.unresolved) sink.add(n)
    return { ...item, key: k.text, value: v.text }
  })
}

export interface ResolveResult {
  spec: CurlSpec
  /** 替换后仍存在的变量名。 */
  unresolved: string[]
}

/**
 * 生成"可直接发送"的 spec 副本。
 * 原始 spec 不被修改（UI 里编辑态与发送态必须是两份，否则变量会被吃掉无法还原）。
 */
export function resolveSpec(spec: CurlSpec, vars: VarMap): ResolveResult {
  const unresolved = new Set<string>()
  const out = cloneSpec(spec)
  const r = (text: string): string => {
    const res = resolveText(text, vars)
    for (const n of res.unresolved) unresolved.add(n)
    return res.text
  }

  out.url = r(out.url)
  out.query = resolveList(out.query, vars, unresolved)
  out.headers = resolveList(out.headers, vars, unresolved)

  out.body.json = r(out.body.json)
  out.body.raw = r(out.body.raw)
  out.body.form = resolveList(out.body.form, vars, unresolved)
  out.body.multipart = out.body.multipart.map((m) => {
    const key = r(m.key)
    const value = r(m.value)
    const filename = m.filename === undefined ? undefined : r(m.filename)
    const contentType = m.contentType === undefined ? undefined : r(m.contentType)
    return { ...m, key, value, filename, contentType }
  })

  out.auth.basic = { username: r(out.auth.basic.username), password: r(out.auth.basic.password) }
  out.auth.bearer = { token: r(out.auth.bearer.token) }
  out.options.userAgent = r(out.options.userAgent)
  out.options.proxy = r(out.options.proxy)
  out.rawArgs = out.rawArgs.map((a) => r(a))

  return { spec: out, unresolved: [...unresolved] }
}

/** 只查未解析变量，不做替换（发送前校验用）。 */
export function findUnresolvedVars(spec: CurlSpec, vars: VarMap): string[] {
  const names = new Set<string>()
  const scan = (text: string): void => {
    for (const n of extractVars(text)) if (vars[n] === undefined) names.add(n)
  }
  scan(spec.url)
  for (const q of spec.query) {
    scan(q.key)
    scan(q.value)
  }
  for (const h of spec.headers) {
    scan(h.key)
    scan(h.value)
  }
  scan(spec.body.json)
  scan(spec.body.raw)
  for (const f of spec.body.form) {
    scan(f.key)
    scan(f.value)
  }
  for (const m of spec.body.multipart) {
    scan(m.key)
    scan(m.value)
    if (m.filename) scan(m.filename)
    if (m.contentType) scan(m.contentType)
  }
  scan(spec.auth.basic.username)
  scan(spec.auth.basic.password)
  scan(spec.auth.bearer.token)
  scan(spec.options.userAgent)
  scan(spec.options.proxy)
  for (const a of spec.rawArgs) scan(a)
  return [...names]
}
