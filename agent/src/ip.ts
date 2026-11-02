import { isIP, isIPv4, isIPv6 } from 'node:net'

/**
 * IP 字面量与 CIDR 的纯判定（SSRF 的最底层）。单独成模块是因为这里的位运算一旦写错，
 * 上面整条 allowlist 判断就是空的——所以它得能脱离网络、对着已知值逐条钉死（判据抄实测）。
 *
 * 地址一律按剥掉方括号后的裸字面量比较：URL 里的 `[::1]`、--resolve 里带方括号的 IPv6，
 * 都先 normalize 再判。
 */

/** 剥掉 IPv6 字面量外层的方括号；顺便 trim。 */
export function stripBrackets(host: string): string {
  const h = host.trim()
  return h.startsWith('[') && h.endsWith(']') ? h.slice(1, -1) : h
}

/** 点分 IPv4 → 32 位无符号整数；非法返回 null。 */
export function ipv4ToLong(s: string): number | null {
  if (!isIPv4(s)) return null
  let n = 0
  for (const seg of s.split('.')) {
    const v = Number(seg)
    if (!Number.isInteger(v) || v < 0 || v > 255) return null
    n = (n << 8) | v
  }
  return n >>> 0
}

function wordsToBig(words: string[]): bigint | null {
  let n = 0n
  for (const w of words) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(w)) return null
    n = (n << 16n) | BigInt(parseInt(w, 16))
  }
  return n
}

/** 完整 IPv6（含 :: 压缩与尾置 IPv4）→ 128 位整数；非法返回 null。 */
export function ipv6ToBigInt(input: string): bigint | null {
  const raw = input.trim()
  if (!isIPv6(raw)) return null
  let s = raw
  // 尾置 IPv4（如 ::ffff:1.2.3.4）先展开成两个 16 位段
  const v4 = /:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(s)
  if (v4) {
    const long = ipv4ToLong(v4[1] as string)
    if (long === null) return null
    const hi = ((long >>> 16) & 0xffff).toString(16)
    const lo = (long & 0xffff).toString(16)
    s = s.slice(0, v4.index) + ':' + hi + ':' + lo
  }
  if (s.includes('::')) {
    const parts = s.split('::')
    if (parts.length !== 2) return null
    const head = parts[0] === '' ? [] : (parts[0] as string).split(':')
    const tail = parts[1] === '' ? [] : (parts[1] as string).split(':')
    const fill = 8 - head.length - tail.length
    if (fill < 0) return null
    return wordsToBig([...head, ...Array.from({ length: fill }, () => '0'), ...tail])
  }
  const words = s.split(':')
  if (words.length !== 8) return null
  return wordsToBig(words)
}

/** 是不是 IP 字面量（v4 或 v6，已剥括号）。 */
export function isIpLiteral(host: string): false | 4 | 6 {
  const h = stripBrackets(host)
  if (isIPv4(h)) return 4
  if (isIPv6(h)) return 6
  return false
}

/** 从 IPv4-mapped IPv6（::ffff:a.b.c.d）里取出那个 v4；不是就 null。 */
export function v4MappedToV4(ip6: string): string | null {
  const m = /^::ffff:((?:\d{1,3}\.){3}\d{1,3})$/i.exec(ip6.trim())
  return m ? (m[1] as string) : null
}

export interface Cidr {
  family: 4 | 6
  base: bigint
  mask: bigint
}

/** 解析 CIDR；前缀越界 / 地址非法都返回 null。 */
export function parseCidr(text: string): Cidr | null {
  const t = text.trim()
  const slash = t.lastIndexOf('/')
  if (slash < 0) return null
  const addr = t.slice(0, slash)
  const prefix = Number(t.slice(slash + 1))
  if (!Number.isInteger(prefix)) return null
  if (isIPv4(addr)) {
    if (prefix < 0 || prefix > 32) return null
    const v = BigInt(ipv4ToLong(addr) as number)
    const mask = prefix === 0 ? 0n : (BigInt(0xffffffff) << BigInt(32 - prefix)) & BigInt(0xffffffff)
    return { family: 4, base: v & mask, mask }
  }
  if (isIPv6(addr)) {
    if (prefix < 0 || prefix > 128) return null
    const v = ipv6ToBigInt(addr)
    if (v === null) return null
    const full = (1n << 128n) - 1n
    const mask = prefix === 0 ? 0n : full ^ ((1n << BigInt(128 - prefix)) - 1n)
    return { family: 6, base: v & mask, mask }
  }
  return null
}

/** 某个 IP 字面量是否落在给定 CIDR 内（异族一律 false）。 */
export function ipInCidr(ipText: string, cidr: Cidr): boolean {
  const ip = stripBrackets(ipText)
  if (isIPv4(ip)) {
    if (cidr.family !== 4) return false
    return (BigInt(ipv4ToLong(ip) as number) & cidr.mask) === cidr.base
  }
  if (isIPv6(ip)) {
    if (cidr.family !== 6) return false
    const v = ipv6ToBigInt(ip)
    if (v === null) return false
    return (v & cidr.mask) === cidr.base
  }
  return false
}

/**
 * 无条件硬禁的目标（放行名单也压不过它）——都是各云的元数据端点或链路本地/唯一本地段：
 *  169.254/16 覆盖 AWS·GCP·阿里的 link-local 元数据（含 169.254.169.254）；
 *  100.100.100.200 是阿里云 VPC 元数据；0/8 是"本机"段；
 *  fe80::/10 是 v6 链路本地，fc00::/7 是唯一本地地址（含计划点名的 fd00::/8）。
 * 环回与私网（127/8、10/8、172.16/12、192.168/16）不在这里硬禁，而是默认不放行、
 * 需运维显式写进 allowlist——因为拿 agent 测自己那台机器上的本地服务，是一种合理用法。
 */
const HARD_DENY_V4 = ['169.254.0.0/16', '100.100.100.200/32', '0.0.0.0/8']
const HARD_DENY_V6 = ['fe80::/10', 'fc00::/7']

/** 这个地址是不是被无条件硬禁的元数据 / 链路本地 / 唯一本地端点。 */
export function isHardDenied(host: string): boolean {
  const ip = stripBrackets(host)
  // v4-mapped v6 也要按它藏着的 v4 判一遍（::ffff:169.254.169.254）
  const v4Forms = [ip]
  if (isIPv6(ip)) {
    const mapped = v4MappedToV4(ip)
    if (mapped !== null) v4Forms.push(mapped)
  }
  for (const form of v4Forms) {
    for (const c of HARD_DENY_V4) {
      const cidr = parseCidr(c)
      if (cidr !== null && ipInCidr(form, cidr)) return true
    }
  }
  for (const c of HARD_DENY_V6) {
    const cidr = parseCidr(c)
    if (cidr !== null && ipInCidr(ip, cidr)) return true
  }
  return false
}

/** 供上层复用：确认 host 是 IP 时才走 IP 判定；返回族与裸字面量。 */
export function asIp(host: string): { family: 4 | 6; text: string } | null {
  const h = stripBrackets(host)
  if (!isIP(h)) return null
  return { family: isIPv4(h) ? 4 : 6, text: h }
}
