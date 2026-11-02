import { describe, expect, it } from 'vitest'
import {
  asIp,
  ipInCidr,
  ipv4ToLong,
  ipv6ToBigInt,
  isHardDenied,
  isIpLiteral,
  parseCidr,
  stripBrackets,
  v4MappedToV4
} from '../src/ip'

describe('字面量与括号', () => {
  it('stripBrackets 只剥最外层方括号', () => {
    expect(stripBrackets('[::1]')).toBe('::1')
    expect(stripBrackets('  example.com  ')).toBe('example.com')
    expect(stripBrackets('1.2.3.4')).toBe('1.2.3.4')
  })

  it('isIpLiteral 认 v4 / v6 / 主机名', () => {
    expect(isIpLiteral('1.2.3.4')).toBe(4)
    expect(isIpLiteral('[::1]')).toBe(6)
    expect(isIpLiteral('2001:db8::1')).toBe(6)
    expect(isIpLiteral('internal.api')).toBe(false)
  })

  it('asIp 给出族与裸字面量', () => {
    expect(asIp('[2001:db8::1]')).toEqual({ family: 6, text: '2001:db8::1' })
    expect(asIp('10.0.0.5')).toEqual({ family: 4, text: '10.0.0.5' })
    expect(asIp('nope.example')).toBeNull()
  })
})

describe('IPv4 → 整数', () => {
  it('边界值', () => {
    expect(ipv4ToLong('0.0.0.0')).toBe(0)
    expect(ipv4ToLong('10.0.0.1')).toBe(167772161)
    expect(ipv4ToLong('255.255.255.255')).toBe(4294967295)
  })
  it('非法返回 null', () => {
    expect(ipv4ToLong('256.0.0.1')).toBeNull()
    expect(ipv4ToLong('1.2.3')).toBeNull()
  })
})

describe('IPv6 → 128 位整数', () => {
  it('压缩与全量', () => {
    expect(ipv6ToBigInt('::')).toBe(0n)
    expect(ipv6ToBigInt('::1')).toBe(1n)
    expect(ipv6ToBigInt('ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff')).toBe((1n << 128n) - 1n)
    expect(ipv6ToBigInt('fe80::')).toBe(0xfe80n << 112n)
    expect(ipv6ToBigInt('2001:db8::1')).toBe((0x2001n << 112n) | (0xdb8n << 96n) | 1n)
  })
  it('尾置 IPv4 展开', () => {
    const mapped = ipv6ToBigInt('::ffff:1.2.3.4')
    expect(mapped).toBe(0xffffn << 32n | BigInt(ipv4ToLong('1.2.3.4') as number))
  })
  it('非法返回 null', () => {
    expect(ipv6ToBigInt(':::1')).toBeNull()
    expect(ipv6ToBigInt('1.2.3.4')).toBeNull()
    expect(ipv6ToBigInt('gg00::')).toBeNull()
  })
})

describe('v4-mapped 还原', () => {
  it('取出藏在 v6 里的 v4', () => {
    expect(v4MappedToV4('::ffff:1.2.3.4')).toBe('1.2.3.4')
    expect(v4MappedToV4('::FFFF:8.8.8.8')).toBe('8.8.8.8')
    expect(v4MappedToV4('2001:db8::1')).toBeNull()
  })
})

describe('CIDR 解析与包含', () => {
  it('v4 段', () => {
    const c = parseCidr('10.0.0.0/8')
    expect(c).not.toBeNull()
    expect(ipInCidr('10.1.2.3', c as never)).toBe(true)
    expect(ipInCidr('11.0.0.0', c as never)).toBe(false)
    expect(ipInCidr('9.255.255.255', c as never)).toBe(false)
  })
  it('/0 覆盖全 v4，异族不命中', () => {
    const any = parseCidr('0.0.0.0/0')
    expect(ipInCidr('203.0.113.9', any as never)).toBe(true)
    const v6 = parseCidr('2001:db8::/32')
    expect(ipInCidr('10.0.0.1', v6 as never)).toBe(false)
    expect(ipInCidr('2001:db8:99::1', v6 as never)).toBe(true)
    expect(ipInCidr('2001:db9::1', v6 as never)).toBe(false)
  })
  it('非法前缀 / 无斜杠返回 null', () => {
    expect(parseCidr('10.0.0.0/33')).toBeNull()
    expect(parseCidr('10.0.0.0/8/8')).toBeNull()
    expect(parseCidr('10.0.0.0')).toBeNull()
    expect(parseCidr('not.an.ip/8')).toBeNull()
    expect(parseCidr('2001:db8::/129')).toBeNull()
  })
})

describe('无条件硬禁（元数据 / 链路本地 / 唯一本地）', () => {
  it('各云元数据与链路本地命中', () => {
    expect(isHardDenied('169.254.169.254')).toBe(true)
    expect(isHardDenied('169.254.1.1')).toBe(true) // 整段 169.254/16
    expect(isHardDenied('100.100.100.200')).toBe(true) // 阿里云 VPC 元数据
    expect(isHardDenied('0.0.0.0')).toBe(true)
    expect(isHardDenied('fd12:3456::1')).toBe(true) // fc00::/7 覆盖 fd00::/8
    expect(isHardDenied('fe80::1')).toBe(true)
  })
  it('藏在 v4-mapped 里的元数据也拦住', () => {
    expect(isHardDenied('::ffff:169.254.169.254')).toBe(true)
  })
  it('环回 / 公网 / 普通私网不在硬禁（交给 allowlist 默认拒绝）', () => {
    expect(isHardDenied('127.0.0.1')).toBe(false)
    expect(isHardDenied('10.0.0.5')).toBe(false)
    expect(isHardDenied('8.8.8.8')).toBe(false)
    expect(isHardDenied('2001:db8::1')).toBe(false)
    expect(isHardDenied('internal.api')).toBe(false) // 主机名不在此判
  })
})
