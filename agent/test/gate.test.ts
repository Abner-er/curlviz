import { describe, expect, it } from 'vitest'
import { CURLSPEC_VERSION, createDefaultSpec } from '@curlviz/core'
import { checkAccess } from '../src/gate'
import type { AgentConfig } from '../src/config'
import { parseAllowlist } from '../src/ssrf'

function cfg(over: Partial<AgentConfig> = {}): AgentConfig {
  return {
    port: 8788,
    token: null,
    allowedOrigins: [],
    allowlist: parseAllowlist(['internal.api']),
    maxTimeMs: 60_000,
    maxPreviewBytes: 524_288,
    maxBodyBytes: 1_048_576,
    maxConcurrency: 8,
    ratePerMinute: 30,
    ...over
  }
}

/** 造一份能过 buildArgv 的完整 spec（关掉跟随重定向，否则 v1 SSRF 会拒 -L）。 */
function json(url: string, extra?: Record<string, unknown>): unknown {
  const spec = createDefaultSpec('t')
  spec.url = url
  spec.options.followRedirects = false
  return { v: CURLSPEC_VERSION, spec: { ...spec, ...extra } }
}

describe('checkAccess：Origin', () => {
  it('白名单为空则不校验 Origin', () => {
    const r = checkAccess(json('https://internal.api'), {}, cfg({ allowedOrigins: [] }))
    expect(r.allow).toBe(true)
  })
  it('配了白名单：缺失或不匹配 → 403 agent-rejected', () => {
    const c = cfg({ allowedOrigins: ['https://a.com'] })
    expect(checkAccess(json('https://internal.api'), {}, c)).toMatchObject({ allow: false, status: 403 })
    expect(checkAccess(json('https://internal.api'), { origin: 'https://evil.com' }, c)).toMatchObject({
      allow: false,
      status: 403
    })
  })
  it('配了白名单：命中放行（大小写不敏感）', () => {
    const r = checkAccess(json('https://internal.api'), { origin: 'https://A.COM' }, cfg({ allowedOrigins: ['https://a.com'] }))
    expect(r.allow).toBe(true)
  })
})

describe('checkAccess：token', () => {
  it('未设 token → 不要求', () => {
    expect(checkAccess(json('https://internal.api'), {}, cfg({ token: null })).allow).toBe(true)
  })
  it('设了 token：缺失/错值 → 401；正确 → 放行', () => {
    const c = cfg({ token: 'sekrit' })
    expect(checkAccess(json('https://internal.api'), {}, c)).toMatchObject({ allow: false, status: 401 })
    expect(checkAccess(json('https://internal.api'), { token: 'wrong' }, c)).toMatchObject({ allow: false, status: 401 })
    expect(checkAccess(json('https://internal.api'), { token: 'sekrit' }, c).allow).toBe(true)
  })
})

describe('checkAccess：请求契约', () => {
  it('版本不符 → 400', () => {
    const r = checkAccess({ v: 99, spec: { url: 'https://internal.api' } }, {}, cfg())
    expect(r).toMatchObject({ allow: false, status: 400 })
    if (!r.allow) expect(r.response.failure.kind).toBe('agent-rejected')
  })
  it('非对象体 → 400', () => {
    expect(checkAccess('nope', {}, cfg())).toMatchObject({ allow: false, status: 400 })
  })
})

describe('checkAccess：SSRF（先硬禁再默认拒）', () => {
  it('白名单内 URL → 放行并回 spec+argv', () => {
    const r = checkAccess(json('https://internal.api/v1'), {}, cfg())
    expect(r.allow).toBe(true)
    if (r.allow) {
      expect(r.spec.url).toBe('https://internal.api/v1')
      expect(r.argv).toBeInstanceOf(Array)
    }
  })
  it('未放行主机 → 403 agent-rejected', () => {
    const r = checkAccess(json('https://evil.com'), {}, cfg())
    expect(r).toMatchObject({ allow: false, status: 403 })
    if (!r.allow) expect(r.response.failure.kind).toBe('agent-rejected')
  })
  it('元数据 URL → 403（硬禁）', () => {
    const r = checkAccess(json('http://169.254.169.254/latest/meta-data'), {}, cfg())
    expect(r).toMatchObject({ allow: false, status: 403 })
    if (!r.allow) expect(r.response.failure.message).toContain('硬禁')
  })
  it('跟随重定向（-L）→ 403 redirect', () => {
    const spec = createDefaultSpec('t')
    spec.url = 'https://internal.api'
    spec.options.followRedirects = true
    const r = checkAccess({ v: CURLSPEC_VERSION, spec }, {}, cfg())
    expect(r).toMatchObject({ allow: false, status: 403 })
    if (!r.allow) expect(r.response.failure.message).toContain('重定向')
  })
})
