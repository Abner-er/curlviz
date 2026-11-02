import { describe, expect, it } from 'vitest'
import {
  collectTargets,
  evaluateSsrf,
  isAllowedByList,
  parseAllowlist,
  parseRule,
  type AllowRule
} from '../src/ssrf'

function rules(lines: string[]): AllowRule[] {
  return parseAllowlist(lines)
}

describe('parseRule：一条文本 → 一种规则', () => {
  it('精确主机名', () => {
    expect(parseRule('Internal.API')).toEqual({ kind: 'host', host: 'internal.api' })
  })
  it('通配 *. 前缀取后缀', () => {
    expect(parseRule('*.svc.cluster.local')).toEqual({ kind: 'wild', suffix: 'svc.cluster.local' })
  })
  it('IP 字面量（v4 / v6 带括号）', () => {
    expect(parseRule('10.0.0.5')).toEqual({ kind: 'ip', family: 4, text: '10.0.0.5' })
    expect(parseRule('[2001:db8::1]')).toEqual({ kind: 'ip', family: 6, text: '2001:db8::1' })
  })
  it('CIDR 段', () => {
    const r = parseRule('10.0.0.0/8')
    expect(r?.kind).toBe('cidr')
  })
  it('非法写法返回 null（不悄悄放行）', () => {
    expect(parseRule('')).toBeNull()
    expect(parseRule('*.')).toBeNull() // *. 后空
    expect(parseRule('*.*.com')).toBeNull() // 多级通配
    expect(parseRule('*.10.0.0.1')).toBeNull() // *. 后是 IP
    expect(parseRule('http://internal.api')).toBeNull() // 带协议
    expect(parseRule('internal.api:8080')).toBeNull() // 带端口
    expect(parseRule('10.0.0.0/33')).toBeNull() // 前缀越界
  })
})

describe('parseAllowlist：跳空行与注释', () => {
  it('只留能解析的行', () => {
    const r = rules(['# comment', '', 'internal.api', '*.svc', ' 10.0.0.0/8 '])
    expect(r).toHaveLength(3)
  })
})

describe('isAllowedByList：族要对得上', () => {
  it('主机名只与 host/wild 配，IP 只与 ip/cidr 配', () => {
    const list = rules(['internal.api', '*.svc', '10.0.0.5', '192.168.0.0/16'])
    expect(isAllowedByList('internal.api', list)).toBe(true)
    expect(isAllowedByList('a.svc', list)).toBe(true)
    expect(isAllowedByList('svc', list)).toBe(true) // wild 含自身
    expect(isAllowedByList('x.a.svc', list)).toBe(true)
    expect(isAllowedByList('evilnotsvc', list)).toBe(false) // 不被 .svc 误收
    expect(isAllowedByList('10.0.0.5', list)).toBe(true)
    expect(isAllowedByList('192.168.1.9', list)).toBe(true)
    // 主机名规则不匹配 IP 目标，反之亦然
    expect(isAllowedByList('10.0.0.9', rules(['10.0.0.5']))).toBe(false)
    expect(isAllowedByList('internal.api', rules(['10.0.0.5']))).toBe(false)
  })
})

describe('collectTargets：从 argv 抓全部连接面', () => {
  it('URL + --resolve 钉的 IP 都收', () => {
    const { targets } = collectTargets(['--resolve', 'internal.api:443:10.0.0.9', 'https://internal.api/v1'], 'https://internal.api/v1')
    const hosts = targets.map((t) => t.host)
    expect(hosts).toContain('internal.api')
    expect(hosts).toContain('10.0.0.9')
  })
  it('--resolve 值带方括号 v6 也能拆对', () => {
    const { targets } = collectTargets(['--resolve', 'api:443:[fe80::1]'], '')
    expect(targets.find((t) => t.role === 'resolve')?.host).toBe('fe80::1')
  })
  it('--connect-to 取目的地（第 3 段）', () => {
    const { targets } = collectTargets(['--connect-to', 'external.com:443:mirror.internal:8443'], '')
    expect(targets.find((t) => t.role === 'connect-to')?.host).toBe('mirror.internal')
  })
  it('-x 无 scheme 按 socks5 解析、--proxy=值 连写都收', () => {
    const a = collectTargets(['-x', '127.0.0.1:1080', 'https://x'], '')
    expect(a.targets.find((t) => t.role === 'proxy')?.host).toBe('127.0.0.1')
    const b = collectTargets(['--proxy=http://corp-proxy:3128'], '')
    expect(b.targets.find((t) => t.role === 'proxy')?.host).toBe('corp-proxy')
  })
  it('-L 被识别为跟随重定向', () => {
    expect(collectTargets(['-L', 'https://x'], '').followsRedirects).toBe(true)
    expect(collectTargets(['--location-trusted', 'https://x'], '').followsRedirects).toBe(true)
    expect(collectTargets(['https://x'], '').followsRedirects).toBe(false)
  })
})

describe('evaluateSsrf：先硬禁再默认拒', () => {
  const allow = rules(['internal.api', '*.svc', '10.0.0.0/8', '127.0.0.1'])

  it('白名单内的 URL 放行', () => {
    const d = evaluateSsrf({ argv: ['https://internal.api/v1'], url: 'https://internal.api/v1', rules: allow })
    expect(d.ok).toBe(true)
  })
  it('未放行的公网主机默认拒', () => {
    const d = evaluateSsrf({ argv: ['https://evil.com'], url: 'https://evil.com', rules: allow })
    expect(d.ok).toBe(false)
    if (!d.ok) expect(d.kind).toBe('not-allowed')
  })
  it('--resolve 把白名单域名钉到元数据 IP：URL 过了，resolve 目标硬禁', () => {
    const d = evaluateSsrf({
      argv: ['--resolve', 'internal.api:443:169.254.169.254', 'https://internal.api/v1'],
      url: 'https://internal.api/v1',
      rules: allow
    })
    expect(d.ok).toBe(false)
    if (!d.ok) {
      expect(d.kind).toBe('hard-deny')
      expect(d.target).toBe('169.254.169.254')
    }
  })
  it('--resolve 钉到不在白名单的私网：默认拒（不是硬禁）', () => {
    const d = evaluateSsrf({
      argv: ['--resolve', 'internal.api:443:172.16.5.5', 'https://internal.api/v1'],
      url: 'https://internal.api/v1',
      rules: allow
    })
    expect(d.ok).toBe(false)
    if (!d.ok) expect(d.kind).toBe('not-allowed')
  })
  it('藏在 v4-mapped 里的元数据也拦', () => {
    const d = evaluateSsrf({
      argv: ['--resolve', 'internal.api:443:[::ffff:169.254.169.254]', 'https://internal.api/v1'],
      url: 'https://internal.api/v1',
      rules: allow
    })
    expect(d.ok).toBe(false)
    if (!d.ok) expect(d.kind).toBe('hard-deny')
  })
  it('127.0.0.1 显式放行（测本机服务是合理用法），但元数据 169.254 压不过', () => {
    expect(evaluateSsrf({ argv: [], url: 'http://127.0.0.1:8080/echo', rules: allow }).ok).toBe(true)
    expect(evaluateSsrf({ argv: [], url: 'http://169.254.169.254/latest/meta', rules: allow }).ok).toBe(false)
  })
  it('-L 直接拒，且在其它检查之前', () => {
    const d = evaluateSsrf({ argv: ['-L', 'https://internal.api'], url: 'https://internal.api', rules: allow })
    expect(d.ok).toBe(false)
    if (!d.ok) expect(d.kind).toBe('redirect')
  })
  it('代理指向元数据：即使 URL 白名单也拒', () => {
    const d = evaluateSsrf({ argv: ['--proxy=http://169.254.169.254:80'], url: 'https://internal.api', rules: allow })
    expect(d.ok).toBe(false)
    if (!d.ok) expect(d.kind).toBe('hard-deny')
  })
})
