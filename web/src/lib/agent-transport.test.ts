import { describe, expect, it } from 'vitest'
import { bytesToBase64, createDefaultSpec, type CurlSpec, type ResolveResult } from '@curlviz/core'
import type { AgentExecutor } from '../types'
import {
  buildSendReport,
  isAgentWire,
  readWire,
  sendViaAgent,
  toSentResponse,
  type AgentWire,
  type AgentWireResponse
} from './agent-transport'

const EXECUTOR: AgentExecutor = { id: 'e1', name: 'ECS-1', baseUrl: 'https://ecs.test/', token: 'tk-123' }

function wireResponse(over: Partial<AgentWireResponse> = {}): AgentWireResponse {
  const body = new TextEncoder().encode('{"a":1}')
  return {
    status: 200,
    statusText: 'OK',
    ok: true,
    headers: [['server', 'nginx']],
    contentType: 'application/json',
    bodyBase64: bytesToBase64(body),
    totalBytes: body.length,
    sizeExact: true,
    truncated: false,
    ttfbMs: 20,
    totalMs: 35,
    ...over
  }
}

function resolved(spec: CurlSpec, unresolved: string[] = []): ResolveResult {
  return { spec, unresolved }
}

function baseSpec(): CurlSpec {
  const s = createDefaultSpec('t')
  s.url = 'https://api.internal/ping'
  return s
}

describe('toSentResponse：wire → SentResponse', () => {
  it('base64 体解成文本，headers 元组转 Param2，归类 json', () => {
    const resp = toSentResponse(wireResponse())
    expect(resp.status).toBe(200)
    expect(resp.text).toBe('{"a":1}')
    expect(resp.kind).toBe('json')
    expect(resp.bytes).toBeInstanceOf(Uint8Array)
    expect(resp.headers).toEqual([{ name: 'server', value: 'nginx' }])
    expect(resp.truncated).toBe(false)
    expect(resp.sizeExact).toBe(true)
    expect(resp.totalMs).toBe(35)
  })

  it('空体不硬凑文本', () => {
    const resp = toSentResponse(wireResponse({ bodyBase64: '', totalBytes: 0, contentType: '' }))
    expect(resp.bytes.length).toBe(0)
    expect(resp.text).toBe('')
  })
})

describe('buildSendReport：wire → SendReport', () => {
  it('成功：outcome.ok、blockedHeaders 空、notes 说明是真 curl、curl 原样带出', () => {
    const wire: AgentWire = { ok: true, response: wireResponse() }
    const rep = buildSendReport(wire, { curl: "curl 'https://api.internal/ping'", unresolved: [], sentAt: 1000, executorName: 'ECS-1' })
    expect(rep.outcome.ok).toBe(true)
    if (!rep.outcome.ok) return
    expect(rep.outcome.response.status).toBe(200)
    expect(rep.blockedHeaders).toEqual([])
    expect(rep.notes[0]).toContain('真 curl')
    expect(rep.curl).toBe("curl 'https://api.internal/ping'")
    expect(rep.sentAt).toBe(1000)
  })

  it('失败：agent-rejected 分类保留，message/hint 带出', () => {
    const wire: AgentWire = { ok: false, failure: { kind: 'agent-rejected', message: '目标段未放行', hint: '让运维放行 10.0.0.0/8' } }
    const rep = buildSendReport(wire, { curl: 'x', unresolved: [], sentAt: 1, executorName: 'E' })
    expect(rep.outcome.ok).toBe(false)
    if (rep.outcome.ok) return
    expect(rep.outcome.failure.kind).toBe('agent-rejected')
    expect(rep.outcome.failure.message).toBe('目标段未放行')
  })

  it('未知失败 kind 降级成 agent-error', () => {
    const wire: AgentWire = { ok: false, failure: { kind: 'weird', message: 'm' } }
    const rep = buildSendReport(wire, { curl: 'x', unresolved: [], sentAt: 1, executorName: 'E' })
    if (rep.outcome.ok) throw new Error('本该失败')
    expect(rep.outcome.failure.kind).toBe('agent-error')
  })
})

describe('isAgentWire / readWire 契约护栏', () => {
  it('结构对：ok+response.status 数字 / !ok+failure.message 字符串', () => {
    expect(isAgentWire({ ok: true, response: wireResponse() })).toBe(true)
    expect(isAgentWire({ ok: false, failure: { kind: 'x', message: 'y' } })).toBe(true)
    expect(isAgentWire({ ok: true })).toBe(false)
    expect(isAgentWire(null)).toBe(false)
    expect(isAgentWire('str')).toBe(false)
  })

  it('body 不是 JSON → agent-error', async () => {
    const wire = await readWire(new Response('<html>502</html>', { status: 502 }))
    expect(wire.ok).toBe(false)
    if (wire.ok) return
    expect(wire.failure.kind).toBe('agent-error')
    expect(wire.failure.message).toContain('502')
  })

  it('body 是 JSON 但不合契约 → agent-error', async () => {
    const wire = await readWire(new Response(JSON.stringify({ hello: 'world' }), { status: 200 }))
    expect(wire.ok).toBe(false)
  })
})

describe('sendViaAgent：POST /exec 与结果映射（mock fetch，不发真请求）', () => {
  it('成功：POST body 是 {v:1,spec}，带 token 头，返回同形 SendReport', async () => {
    let seenUrl = ''
    let seenInit: RequestInit | undefined
    const fetchImpl = (async (input: unknown, init?: RequestInit) => {
      seenUrl = String(input)
      seenInit = init
      return new Response(JSON.stringify({ ok: true, response: wireResponse() }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    }) as unknown as typeof fetch

    const rep = await sendViaAgent(resolved(baseSpec()), EXECUTOR, 'curl X', { fetchImpl })
    expect(seenUrl).toBe('https://ecs.test/exec')
    expect(seenInit?.method).toBe('POST')
    const headers = seenInit?.headers as Record<string, string>
    expect(headers['content-type']).toBe('application/json')
    expect(headers['x-curlviz-token']).toBe('tk-123')
    const sent = JSON.parse(String(seenInit?.body)) as { v: number; spec: CurlSpec }
    expect(sent.v).toBe(1)
    expect(sent.spec.url).toBe('https://api.internal/ping')
    expect(rep.outcome.ok).toBe(true)
    expect(rep.curl).toBe('curl X')
    expect(rep.blockedHeaders).toEqual([])
  })

  it('token 为空：不带 x-curlviz-token 头（对应 OIDC/mTLS 部署）', async () => {
    let seenInit: RequestInit | undefined
    const fetchImpl = (async (_u: unknown, init?: RequestInit) => {
      seenInit = init
      return new Response(JSON.stringify({ ok: false, failure: { kind: 'agent-rejected', message: 'no token' } }))
    }) as unknown as typeof fetch
    await sendViaAgent(resolved(baseSpec()), { ...EXECUTOR, token: '  ' }, 'x', { fetchImpl })
    const headers = seenInit?.headers as Record<string, string>
    expect(headers['x-curlviz-token']).toBeUndefined()
  })

  it('网络层抛 TypeError → unreachable，不编造成 CORS', async () => {
    const fetchImpl = (async () => {
      throw new TypeError('fetch failed')
    }) as unknown as typeof fetch
    const rep = await sendViaAgent(resolved(baseSpec()), EXECUTOR, 'x', { fetchImpl })
    if (rep.outcome.ok) throw new Error('本该失败')
    expect(rep.outcome.failure.kind).toBe('unreachable')
    expect(rep.outcome.failure.raw).toContain('fetch failed')
  })

  it('取消（AbortError）→ abort', async () => {
    const fetchImpl = (async () => {
      throw Object.assign(new Error('aborted'), { name: 'AbortError' })
    }) as unknown as typeof fetch
    const rep = await sendViaAgent(resolved(baseSpec()), EXECUTOR, 'x', { fetchImpl })
    if (rep.outcome.ok) throw new Error('本该失败')
    expect(rep.outcome.failure.kind).toBe('abort')
  })

  it('超时（TimeoutError）→ timeout', async () => {
    const fetchImpl = (async () => {
      throw Object.assign(new Error('timeout'), { name: 'TimeoutError' })
    }) as unknown as typeof fetch
    const rep = await sendViaAgent(resolved(baseSpec()), EXECUTOR, 'x', { fetchImpl, timeoutMs: 5000 })
    if (rep.outcome.ok) throw new Error('本该失败')
    expect(rep.outcome.failure.kind).toBe('timeout')
  })
})
