import {
  asIp,
  ipInCidr,
  isHardDenied,
  parseCidr,
  stripBrackets,
  type Cidr
} from './ip'

/**
 * SSRF 闸门（agent 侧，纯逻辑）。它决定"这条 spec 让不让跑"，是整台 agent 的安全边界——
 * 一旦这里松，用户 ECS 就成了任意内网/元数据的跳板。所以对着 ip.ts 那套已验的位运算，
 * 逐条钉死：先无条件硬禁元数据段，再对**每一个会改变连接目标的来源**做默认拒绝的白名单匹配。
 *
 * 为什么扫 argv 而不是只看结构化 spec：agent 路径 rawArgs 照常执行（spec §13.2），
 * 一条藏在 rawArgs 里的 `--resolve host:443:169.254.169.254` 若只查结构体就绕过去了。
 * 于是把 buildArgv 吐出的**最终 argv**连同 spec.url 一起收集连接目标，统一判。
 */

/** 一条放行规则。运维在 allowlist 里逐条写，缺省一切拒绝。 */
export type AllowRule =
  | { kind: 'host'; host: string } // 精确主机名（小写）
  | { kind: 'wild'; suffix: string } // *.example.com → suffix=example.com，匹配自身与任意子域
  | { kind: 'ip'; family: 4 | 6; text: string } // 裸 IP 字面量精确匹配
  | { kind: 'cidr'; cidr: Cidr } // 网段

/** 收集到的一个连接目标：role 说明它从哪来，方便拒绝时给出可执行提示。 */
export interface Target {
  role: 'url' | 'resolve' | 'connect-to' | 'proxy' | 'doh'
  host: string // 可能是 [v6] 或 v4 或主机名，未剥括号
}

/** 从一行 allowlist 文本解析规则；无法识别返回 null（运维笔误不该悄悄放行）。 */
export function parseRule(text: string): AllowRule | null {
  const t = stripBrackets(text).toLowerCase()
  if (t === '') return null
  if (t.startsWith('*.')) {
    const suffix = t.slice(2)
    // *. 后面必须是主机名，不能是 IP（IP 走 cidr/ip），且不能还有通配或空
    if (suffix === '' || suffix.includes('*') || asIp(suffix) !== null) return null
    return { kind: 'wild', suffix }
  }
  if (t.includes('/')) {
    const cidr = parseCidr(t)
    return cidr === null ? null : { kind: 'cidr', cidr }
  }
  const ip = asIp(t)
  if (ip !== null) return { kind: 'ip', family: ip.family, text: ip.text }
  // 裸主机名：拒绝带协议/端口/路径的写法（那种该由 url 解析出 host 再匹配，不该塞进规则）
  if (/[:/@]/.test(t)) return null
  return { kind: 'host', host: t }
}

export function parseAllowlist(lines: Iterable<string>): AllowRule[] {
  const rules: AllowRule[] = []
  for (const line of lines) {
    const t = line.trim()
    if (t === '' || t.startsWith('#')) continue
    const r = parseRule(t)
    if (r !== null) rules.push(r)
  }
  return rules
}

/** 单个目标主机名是否命中某条规则（IP 目标只与 ip/cidr 规则配，主机名只与 host/wild 配）。 */
function matchesRule(target: string, rule: AllowRule): boolean {
  const h = stripBrackets(target).toLowerCase()
  const ip = asIp(h)
  if (ip !== null) {
    if (rule.kind === 'ip') return rule.family === ip.family && rule.text === ip.text
    if (rule.kind === 'cidr') return ipInCidr(ip.text, rule.cidr)
    return false
  }
  if (rule.kind === 'host') return rule.host === h
  if (rule.kind === 'wild') return h === rule.suffix || h.endsWith(`.${rule.suffix}`)
  return false
}

/** 目标是否被白名单放行（任一规则命中即放行）。 */
export function isAllowedByList(target: string, rules: AllowRule[]): boolean {
  return rules.some((r) => matchesRule(target, r))
}

/* ---------------------------------------------------------------- */
/* 从 URL / host:port 串里取连接主机                                  */
/* ---------------------------------------------------------------- */

/** 把 `[v6]` 或 `v6`（无括号但含冒号段）以外的 `host:port` 拆出 host；括号 v6 保留内容。 */
function hostFromHostPort(value: string): string {
  const v = value.trim()
  if (v === '') return ''
  const br = /^\[([^\]]+)\]/.exec(v)
  if (br) return br[1] as string // [fe80::1]:443 → fe80::1
  const colon = v.indexOf(':')
  return colon < 0 ? v : v.slice(0, colon) // host:port → host（裸 v6 不会走到这，上面括号已处理）
}

/** 从带协议的 URL（proxy / doh-url / spec.url）取 hostname（已无括号）。失败返回 ''。 */
function hostFromUrl(value: string): string {
  const v = value.trim()
  if (v === '') return ''
  try {
    // 允许无协议写法：补 // 让 URL 解析按 authority 走
    const u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(v) ? v : `//${v}`)
    // URL.hostname 对 IPv6 仍带方括号，交给下游 stripBrackets 统一
    return u.hostname
  } catch {
    // 兜底：手动取 authority（挡 http://user:pass@host:port/path 之类 URL 构造失败的怪值）
    const noScheme = v.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '')
    const noCreds = noScheme.slice(noScheme.lastIndexOf('@') + 1)
    const authority = noCreds.split('/')[0] as string
    return hostFromHostPort(authority)
  }
}

/**
 * 把 `:` 分段但把 `[...]` 括号段当作整体：用于 --resolve / --connect-to 这种
 * `host:port:addr` 结构里含方括号 v6 的情况。返回去掉括号的各段。
 */
function colonSplitKeepingBrackets(value: string): string[] {
  const parts: string[] = []
  let cur = ''
  let inBracket = false
  for (const c of value) {
    if (c === '[') {
      inBracket = true
      cur += c
    } else if (c === ']') {
      inBracket = false
      cur += c
    } else if (c === ':' && !inBracket) {
      parts.push(cur)
      cur = ''
    } else {
      cur += c
    }
  }
  parts.push(cur)
  return parts.map((p) => stripBrackets(p))
}

const REDIRECT_FLAGS = new Set(['-L', '--location', '--location-trusted'])
const PROXY_FLAGS = new Set(['-x', '--proxy', '--preproxy'])
const SOCKS_FLAGS = new Set([
  '--socks5',
  '--socks5-hostname',
  '--socks5h',
  '--socks4',
  '--socks4a'
])
// curl 对无 scheme 的 -x 值按 socks5:// 解析，socks5 走 socks5://，socks4 走 socks4://。
const DEFAULT_PROXY_SCHEME = new Map<string, string>([
  ['-x', 'socks5://'],
  ['--proxy', 'socks5://'],
  ['--preproxy', 'socks5://'],
  ['--socks5', 'socks5://'],
  ['--socks5-hostname', 'socks5h://'],
  ['--socks5h', 'socks5h://'],
  ['--socks4', 'socks4://'],
  ['--socks4a', 'socks4://']
])

/** 值可能跟在 flag 后一个 token，或用 --flag=value 连写；两者都归一化取出。 */
function flagValue(argv: string[], i: number, name: string): string | null {
  const tok = argv[i] as string
  if (tok === name) return (argv[i + 1] ?? null) as string | null
  const eq = tok.startsWith(`${name}=`) ? tok.slice(name.length + 1) : null
  return eq
}

/**
 * 扫最终 argv + spec.url，收集所有会真正建立连接的目标主机，并发现是否跟重定向。
 * 这是"攻击面清单"——宁可多收（每个都拿去白名单判），不可漏收。
 */
export function collectTargets(argv: string[], url: string): {
  targets: Target[]
  followsRedirects: boolean
} {
  const targets: Target[] = []
  let followsRedirects = false

  const push = (role: Target['role'], host: string): void => {
    const h = host.trim()
    if (h !== '') targets.push({ role, host: h })
  }

  push('url', hostFromUrl(url))

  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i] as string
    if (REDIRECT_FLAGS.has(tok)) {
      followsRedirects = true
      continue
    }
    if (tok === '--resolve') {
      const val = flagValue(argv, i, '--resolve')
      if (val) {
        const segs = colonSplitKeepingBrackets(val)
        push('resolve', segs[segs.length - 1] as string)
      }
      continue
    }
    if (tok.startsWith('--resolve=')) {
      const segs = colonSplitKeepingBrackets(tok.slice('--resolve='.length))
      push('resolve', segs[segs.length - 1] as string)
      continue
    }
    if (tok === '--connect-to') {
      const val = flagValue(argv, i, '--connect-to')
      if (val) {
        const segs = colonSplitKeepingBrackets(val)
        push('connect-to', segs[2] as string) // remote-host:remote-port:dest-host:dest-port
      }
      continue
    }
    if (tok.startsWith('--connect-to=')) {
      const segs = colonSplitKeepingBrackets(tok.slice('--connect-to='.length))
      push('connect-to', segs[2] as string)
      continue
    }
    if (tok === '--doh-url') {
      push('doh', hostFromUrl(flagValue(argv, i, '--doh-url') ?? ''))
      continue
    }
    if (tok.startsWith('--doh-url=')) {
      push('doh', hostFromUrl(tok.slice('--doh-url='.length)))
      continue
    }
    for (const flag of [...PROXY_FLAGS, ...SOCKS_FLAGS]) {
      const val = flagValue(argv, i, flag)
      if (val !== null) {
        const scheme = DEFAULT_PROXY_SCHEME.get(flag) ?? ''
        const full = /^[a-z][a-z0-9+.-]*:\/\//i.test(val) ? val : `${scheme}${val}`
        push('proxy', hostFromUrl(full))
        break
      }
    }
  }

  return { targets, followsRedirects }
}

export interface SsrfInput {
  argv: string[]
  url: string
  rules: AllowRule[]
}

export type SsrfDecision =
  | { ok: true; targets: Target[] }
  | { ok: false; kind: 'redirect' | 'hard-deny' | 'not-allowed'; target: string; reason: string; hint: string }

/**
 * 判定一条待执行 spec。返回 ok:false 时 server 一律落成 agent-rejected。
 * 顺序：跟重定向直接拒 → 逐个目标先硬禁（元数据/链路本地/ULA，白名单也压不过）→ 白名单默认拒。
 */
export function evaluateSsrf(input: SsrfInput): SsrfDecision {
  const { argv, url, rules } = input
  const { targets, followsRedirects } = collectTargets(argv, url)

  if (followsRedirects) {
    return {
      ok: false,
      kind: 'redirect',
      target: '',
      reason: 'v1 拒绝跟随重定向（-L/--location）。',
      hint: '重定向后的目标在发请求前无法确定，SSRF 白名单管不住它。去掉 -L，或把最终地址单独发一条。'
    }
  }

  for (const t of targets) {
    const host = stripBrackets(t.host)
    if (isHardDenied(host)) {
      return {
        ok: false,
        kind: 'hard-deny',
        target: t.host,
        reason: `目标（${roleName(t.role)}）命中无条件硬禁：${host} 属于云元数据 / 链路本地 / 唯一本地段。`,
        hint: '这类地址任何 allowlist 都不放行。确认不是想打元数据端点；若确需本机服务，用 127.0.0.1 并显式加进 allowlist。'
      }
    }
    if (!isAllowedByList(host, rules)) {
      return {
        ok: false,
        kind: 'not-allowed',
        target: t.host,
        reason: `目标（${roleName(t.role)}）不在 allowlist：${host}。默认拒绝，未显式放行的地址一律不跑。`,
        hint: `在 agent 的 allowlist 里加一条精确匹配 ${host}（主机名可写 ${host} 或 *.${domainSuffix(host)}，IP 可写 ${host} 或其所在 CIDR）。`
      }
    }
  }

  return { ok: true, targets }
}

function roleName(role: Target['role']): string {
  switch (role) {
    case 'url':
      return 'URL'
    case 'resolve':
      return '--resolve 钉到的 IP'
    case 'connect-to':
      return '--connect-to 目的地'
    case 'proxy':
      return '代理'
    case 'doh':
      return 'DoH 服务'
  }
}

/** 从主机名猜一个可粘进 *. 的后缀（去掉第一段）；给 hint 用，不参与判定。 */
function domainSuffix(host: string): string {
  const parts = host.split('.')
  return parts.length > 1 ? parts.slice(1).join('.') : host
}
