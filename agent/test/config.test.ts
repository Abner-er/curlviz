import { describe, expect, it } from 'vitest'
import { DEFAULTS, parseConfig } from '../src/config'

describe('parseConfig：没配 = 安全默认，不是全放行', () => {
  it('全空给保守默认', () => {
    const c = parseConfig({})
    expect(c.port).toBe(DEFAULTS.port)
    expect(c.token).toBeNull()
    expect(c.allowedOrigins).toEqual([])
    expect(c.allowlist).toEqual([])
    expect(c.maxTimeMs).toBe(DEFAULTS.maxTimeMs)
    expect(c.maxPreviewBytes).toBe(512 * 1024)
    expect(c.maxConcurrency).toBe(DEFAULTS.maxConcurrency)
    expect(c.ratePerMinute).toBe(DEFAULTS.ratePerMinute)
  })

  it('token 空串当没设（null），非空才要匹配', () => {
    expect(parseConfig({ CURLVIZ_TOKEN: '   ' }).token).toBeNull()
    expect(parseConfig({ CURLVIZ_TOKEN: 'sekrit' }).token).toBe('sekrit')
  })

  it('Origin 列表拆逗号、去空、转小写', () => {
    const c = parseConfig({ CURLVIZ_ALLOWED_ORIGINS: ' https://A.com , ,https://B.com ' })
    expect(c.allowedOrigins).toEqual(['https://a.com', 'https://b.com'])
  })

  it('allowlist 从逗号串解析成规则', () => {
    const c = parseConfig({ CURLVIZ_ALLOW: 'internal.api,*.svc,10.0.0.0/8' })
    expect(c.allowlist).toHaveLength(3)
    expect(c.allowlist.map((r) => r.kind)).toEqual(['host', 'wild', 'cidr'])
  })

  it('坏数字回退默认，绝不 NaN 上路', () => {
    const c = parseConfig({ CURLVIZ_PORT: 'abc', CURLVIZ_MAX_TIME_MS: '-5', CURLVIZ_MAX_CONCURRENCY: '0' })
    expect(c.port).toBe(DEFAULTS.port) // abc → 默认
    expect(c.maxTimeMs).toBe(1000) // -5 → 夹到下限
    expect(c.maxConcurrency).toBe(1) // 0 → 夹到下限
  })

  it('数字取整', () => {
    expect(parseConfig({ CURLVIZ_RATE_PER_MIN: '12.7' }).ratePerMinute).toBe(12)
  })
})
