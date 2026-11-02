import { describe, expect, it } from 'vitest'
import { CURLSPEC_VERSION } from '@curlviz/core'
import { failure, parseExecRequest } from '../src/wire'

/** 造一份只填了必填浅检字段的最小 spec 体（深校验交给 buildArgv，这里不重造）。 */
function body(over: Record<string, unknown>): unknown {
  return { v: CURLSPEC_VERSION, spec: { url: 'https://internal.api/v1', ...over } }
}

describe('parseExecRequest 请求契约', () => {
  it('合法 v:1 + spec.url → 放行，回填版本号', () => {
    const r = parseExecRequest(body({ method: 'GET' }))
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.request.v).toBe(CURLSPEC_VERSION)
      expect(r.request.spec.url).toBe('https://internal.api/v1')
    }
  })

  it('非对象体直接拒', () => {
    for (const bad of [null, undefined, 42, 'x', []]) {
      const r = parseExecRequest(bad)
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.response.failure.kind).toBe('agent-rejected')
    }
  })

  it('版本不符（含缺失）拒绝、不猜', () => {
    for (const v of [2, 0, '1', undefined, null]) {
      const r = parseExecRequest({ v, spec: { url: 'https://x' } })
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.response.failure.message).toContain(`v:${String(v)}`)
    }
  })

  it('缺 spec / spec 非对象 → 拒', () => {
    expect(parseExecRequest({ v: CURLSPEC_VERSION }).ok).toBe(false)
    expect(parseExecRequest({ v: CURLSPEC_VERSION, spec: 'x' }).ok).toBe(false)
  })

  it('url 空 / 非字符串 / 纯空白 → 拒（没有可执行目标）', () => {
    for (const url of ['', '   ', 42, undefined]) {
      const r = parseExecRequest({ v: CURLSPEC_VERSION, spec: { url } })
      expect(r.ok).toBe(false)
    }
  })
})

describe('failure 构造', () => {
  it('只有 kind+message 时不塞空的 hint/raw 键', () => {
    const f = failure('agent-error', 'boom')
    expect(f).toEqual({ ok: false, failure: { kind: 'agent-error', message: 'boom' } })
  })
  it('给了 hint/raw 才带上', () => {
    const f = failure('timeout', '超了', '调大 -m', 'curl exit 28')
    if (!f.ok) {
      expect(f.failure.hint).toBe('调大 -m')
      expect(f.failure.raw).toBe('curl exit 28')
    }
  })
})
